import {parseTranscript} from "./detector/transcript.js";
import {detectSponsorSegments} from "./detector/detector.js";
import {
    DEFAULT_LLM_ENDPOINT,
    detectSponsorSegmentsWithLlm,
    listLlmModels,
    llmRangeMatchesCandidate,
} from "./detector/llm-detector.js";
import {createLlmCacheKey, readCachedLlmResult, writeCachedLlmResult,} from "./detector/llm-cache.js";

// get the current extension version
const VERSION = chrome.runtime.getManifest?.()?.version ?? "development";
console.log(`notsponsored background v${VERSION} loaded`);
let skipStatsUpdateQueue = Promise.resolve();

// constants and stuff
const SPONSORBLOCK_ENDPOINT = "https://sponsor.ajay.app/api/skipSegments";
const DEFAULT_START_TRIM_SECONDS = 3;
const DEFAULT_END_TRIM_SECONDS = 3;
const MAX_TRIM_SECONDS = 60;
const SPONSORBLOCK_CLUSTER_GAP_MS = 10_000;
const SHORT_LOCAL_VERIFICATION_MAX_MS = 25_000;
const SHORT_LOCAL_CONTEXT_MS = 60_000;
const UNCERTAIN_LOCAL_CONTEXT_MIN_MS = 90_000;
const UNCERTAIN_LOCAL_CONTEXT_MAX_MS = 240_000;
const ROUTING_MODES = new Set([
    "local-only",
    "local-fallback",
    "sponsorblock-only",
]);
const tabState = new Map();
let nextGeneration = 1;

function normalizedChannelHandle(value) {
    const handle = String(value || "").trim();
    if (!handle) return "";
    return handle.startsWith("@") ? handle.toLowerCase() : `@${handle.toLowerCase()}`;
}

async function readBlockedChannelHandles() {
    const settings = await chrome.storage.local.get({
        blockedChannelHandles: [],
    });
    return new Set(
        (Array.isArray(settings.blockedChannelHandles)
            ? settings.blockedChannelHandles
            : [])
            .map(normalizedChannelHandle)
            .filter(Boolean),
    );
}

async function isChannelBlocked(channelHandle) {
    const normalized = normalizedChannelHandle(channelHandle);
    if (!normalized) return false;
    const blocked = await readBlockedChannelHandles();
    return blocked.has(normalized);
}

// check if a tab is current for a given video and generation
function isCurrent(tabId, videoId, generation) {
    const state = tabState.get(tabId);
    return state?.videoId === videoId && state?.generation === generation;
}

// return the normalized trim seconds
function normalizedTrimSeconds(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric)
        ? Math.min(MAX_TRIM_SECONDS, Math.max(0, numeric))
        : fallback;
}

// apply sponsor segment trimming
async function applyTimingTrims(segments, source) {
    if (source === "reset" || segments.length === 0) return segments;

    let settings = {
        startTrimSeconds: DEFAULT_START_TRIM_SECONDS,
        endTrimSeconds: DEFAULT_END_TRIM_SECONDS,
    };
    try {
        settings = await chrome.storage.local.get(settings);
    } catch (error) {
        console.warn("Unable to read sponsor trimming settings, using default trim", error);
    }

    const startTrimMs = normalizedTrimSeconds(
        settings.startTrimSeconds,
        DEFAULT_START_TRIM_SECONDS,
    ) * 1_000;
    const endTrimMs = normalizedTrimSeconds(
        settings.endTrimSeconds,
        DEFAULT_END_TRIM_SECONDS,
    ) * 1_000;

    return segments.map((segment, index) => {
        const previous = segments[index - 1];
        const next = segments[index + 1];
        const startsCluster = source !== "sponsorblock"
            || !previous
            || segment.startMs - previous.endMs > SPONSORBLOCK_CLUSTER_GAP_MS;
        const endsCluster = source !== "sponsorblock"
            || !next
            || next.startMs - segment.endMs > SPONSORBLOCK_CLUSTER_GAP_MS;
        const trimmedStartMs = segment.startMs + (startsCluster ? startTrimMs : 0);
        const trimmedEndMs = segment.endMs - (endsCluster ? endTrimMs : 0);
        return {
            ...segment,
            startMs: trimmedStartMs,
            endMs: trimmedEndMs,
        };
    }).filter(segment => segment.endMs > segment.startMs);
}

// send sponsor segments to a tab
async function sendSegments(tabId, videoId, segments, source) {
    try {
        const adjustedSegments = await applyTimingTrims(segments, source);
        await chrome.tabs.sendMessage(tabId, {
            action: "SET_SPONSOR_SEGMENTS",
            videoId,
            source,
            segments: adjustedSegments,
        });
        console.log(
            `Sent ${adjustedSegments.length} ${source} segment(s) to tab ${tabId} for ${videoId}`,
            adjustedSegments,
        );
    } catch (error) {
        console.debug(`Could not deliver segments to tab ${tabId}: `, error);
    }
}

// normalize segments and return them merged
function normalizeSegments(segments, source) {
    const clean = segments
        .map(item => {
            const pair = Array.isArray(item.segment) ? item.segment : [item.startMs / 1000, item.endMs / 1000];
            const startMs = Number(pair[0]) * 1000;
            const endMs = Number(pair[1]) * 1000;
            const model = typeof item.model === "string"
                ? item.model.trim()
                : "";
            return {
                startMs,
                endMs,
                source: item.source ?? source,
                confidence: item.confidence ?? (source === "sponsorblock" ? "community" : "unknown"),
                reason: item.reason ?? "",
                autoSkip: item.autoSkip !== false,
                ...(model ? {model} : {}),
            };
        })
        .filter(item => Number.isFinite(item.startMs)
            && Number.isFinite(item.endMs)
            && item.startMs >= 0
            && item.endMs > item.startMs)
        .sort((a, b) => a.startMs - b.startMs);

    const merged = [];
    for (const segment of clean) {
        const previous = merged.at(-1);
        if (previous && segment.startMs <= previous.endMs + 1_000) {
            previous.endMs = Math.max(previous.endMs, segment.endMs);
            previous.autoSkip =
                previous.autoSkip && segment.autoSkip;
            if (!previous.model && segment.model) {
                previous.model = segment.model;
            }
        } else {
            merged.push({...segment});
        }
    }
    return merged;
}

// fetch segments from the SponsorBlock API
async function fetchSponsorBlockSegments(videoId) {
    const url = new URL(SPONSORBLOCK_ENDPOINT);
    url.searchParams.set("videoID", videoId);
    url.searchParams.set("category", "sponsor");
    url.searchParams.set("actionType", "skip");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_500);
    try {
        const response = await fetch(url, {cache: "no-store", signal: controller.signal});
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`SponsorBlock returned HTTP ${response.status}`);

        const payload = await response.json();
        return normalizeSegments(
            payload.filter(item => item.category === "sponsor" && (item.actionType ?? "skip") === "skip"),
            "sponsorblock",
        );
    } finally {
        clearTimeout(timeout);
    }
}

// read routing and optional LLM fallback settings
async function readDetectionSettings() {
    const settings = await chrome.storage.local.get({
        toggleExtension: true,
        routingMode: null,
        localOnly: false,
        llmFallbackEnabled: false,
        llmEndpoint: DEFAULT_LLM_ENDPOINT,
        llmApiKey: "",
        llmModel: "",
    });
    return {
        extensionEnabled: settings.toggleExtension !== false,
        routingMode: ROUTING_MODES.has(settings.routingMode)
            ? settings.routingMode
            : settings.localOnly === true
                ? "local-only"
                : "local-fallback",
        llmFallbackEnabled: settings.llmFallbackEnabled === true,
        llmEndpoint: String(settings.llmEndpoint || DEFAULT_LLM_ENDPOINT),
        llmApiKey: String(settings.llmApiKey || ""),
        llmModel: String(settings.llmModel || "").trim(),
    };
}

// check if the given state allows any local detection
function allowsLocalDetection(state) {
    return state.routingMode === "local-only"
        || state.routingMode === "local-fallback";
}

// LLM fallback also needs the transcript in SponsorBlock-only mode.
function allowsTranscriptProcessing(state) {
    return allowsLocalDetection(state) || state.llmFallbackEnabled;
}

// distinguish local-only results from fallback results in logs and UI
function localDetectionSource(state) {
    return state.routingMode === "local-only"
        ? "local-only"
        : "local-fallback";
}

function uncertainLocalSegments(state) {
    if (!Array.isArray(state.pendingLocalSegments)) return [];
    return state.pendingLocalSegments.filter(segment =>
        ["medium", "low"].includes(segment.confidence));
}

function shortHighLocalSegments(state) {
    if (!Array.isArray(state.pendingLocalSegments)) return [];
    return state.pendingLocalSegments.filter(segment =>
        segment.confidence === "high"
        && segment.endMs - segment.startMs
        <= SHORT_LOCAL_VERIFICATION_MAX_MS);
}

function localResultNeedsLlm(state) {
    return Array.isArray(state.pendingLocalSegments)
        && (
            state.pendingLocalSegments.length === 0
            || uncertainLocalSegments(state).length > 0
            || shortHighLocalSegments(state).length > 0
        );
}

function immediatelyDeliverableLocalSegments(state) {
    if (!Array.isArray(state.pendingLocalSegments)) return [];
    if (!state.llmFallbackEnabled) {
        return state.pendingLocalSegments;
    }
    if (uncertainLocalSegments(state).length > 0) return [];
    const shortSegments = new Set(shortHighLocalSegments(state));
    return state.pendingLocalSegments.filter(segment =>
        !shortSegments.has(segment));
}

function uncertainVerificationContextMs(segment) {
    const durationMs = Math.max(0, segment.endMs - segment.startMs);
    return Math.min(
        UNCERTAIN_LOCAL_CONTEXT_MAX_MS,
        Math.max(UNCERTAIN_LOCAL_CONTEXT_MIN_MS, durationMs * 2),
    );
}

// build a plan for how to use the LLM based on the current state
function buildLlmPlan(state) {
    const uncertain = uncertainLocalSegments(state);
    // Verify uncertain candidates in adaptive windows. The LLM detector expands
    // the window again when a returned range reaches an edge.
    if (uncertain.length > 0) {
        return {
            kind: "candidate-verification",
            jobs: uncertain.map(segment => ({
                events: state.transcriptEvents,
                candidates: [segment],
                candidateContextMs: uncertainVerificationContextMs(segment),
            })),
        };
    }


    const short = shortHighLocalSegments(state);
    // any short segments with high certainty = a short verification
    // where only part of the nearby transcript is verified
    if (short.length > 0) {
        return {
            kind: "short-verification",
            jobs: short.map(segment => ({
                events: state.transcriptEvents,
                candidates: [segment],
                candidateContextMs: SHORT_LOCAL_CONTEXT_MS,
            })),
        };
    }

    // if there are no segments at all, scan full video
    return {
        kind: "fallback",
        jobs: [{events: state.transcriptEvents, candidates: []}],
    };
}

// combine the verified LLM segments with the local segments based on the plan
function combineVerifiedLlmSegments(state, llmSegments, plan) {
    const localSegments = Array.isArray(state.pendingLocalSegments)
        ? state.pendingLocalSegments
        : [];
    if (plan.kind === "fallback") return llmSegments;

    let retainedLocalSegments;
    if (plan.kind === "candidate-verification") {
        const verifiedCandidates = new Set(
            plan.jobs.flatMap(job => job.candidates),
        );
        retainedLocalSegments = localSegments.filter(segment => {
            if (llmSegments.some(llmSegment =>
                llmRangeMatchesCandidate(segment, llmSegment))) {
                return false;
            }
            return !verifiedCandidates.has(segment);
        });
    } else {
        const shortSegments = new Set(
            plan.jobs.flatMap(job => job.candidates),
        );
        retainedLocalSegments = localSegments.filter(segment =>
            !shortSegments.has(segment));
    }

    return [...retainedLocalSegments, ...llmSegments]
        .sort((left, right) => left.startMs - right.startMs);
}

// initialize the video processing
async function beginVideo(tabId, videoId, rawChannelHandle = "") {
    tabState.get(tabId)?.llmController?.abort();
    const channelHandle = normalizedChannelHandle(rawChannelHandle);
    const generation = nextGeneration++;
    const state = {
        videoId,
        channelHandle,
        generation,
        sponsorBlockStatus: "pending",
        pendingLocalSegments: null,
        latestScanId: null,
        localTranscriptStatus: null,
        lastTranscriptData: null,
        transcriptEvents: null,
        extensionEnabled: true,
        routingMode: "loading",
        llmFallbackEnabled: false,
        llmEndpoint: DEFAULT_LLM_ENDPOINT,
        llmApiKey: "",
        llmModel: "",
        llmStatus: "disabled",
        llmController: null,
        llmRunId: null,
        queuedTranscript: null,
    };
    tabState.set(tabId, state);
    await sendSegments(tabId, videoId, [], "reset");

    let routingMode = "local-fallback";
    try {
        const settings = await readDetectionSettings();
        routingMode = settings.routingMode;
        state.extensionEnabled = settings.extensionEnabled;
        state.llmFallbackEnabled = settings.llmFallbackEnabled;
        state.llmEndpoint = settings.llmEndpoint;
        state.llmApiKey = settings.llmApiKey;
        state.llmModel = settings.llmModel;
        state.llmStatus = settings.llmFallbackEnabled
            ? "waiting"
            : "disabled";
    } catch (error) {
        console.warn("Unable to read routing setting, using local fallback mode", error);
    }
    if (!isCurrent(tabId, videoId, generation)) return;
    if (!state.extensionEnabled) {
        state.sponsorBlockStatus = "disabled";
        state.routingMode = "disabled";
        state.llmStatus = "disabled";
        return;
    }

    try {
        if (await isChannelBlocked(channelHandle)) {
            state.sponsorBlockStatus = "blocked";
            state.routingMode = "blocked";
            state.llmStatus = "disabled";
            console.info(`Skipping sponsor scanning for blocked channel ${channelHandle} on ${videoId}`);
            return;
        }
    } catch (error) {
        console.warn("Unable to read blocked channel settings; continuing with detection", error);
    }
    if (!isCurrent(tabId, videoId, generation)) return;
    state.routingMode = routingMode;

    const queuedTranscript = state.queuedTranscript;
    state.queuedTranscript = null;
    if (queuedTranscript && allowsTranscriptProcessing(state)) {
        scanTranscript(queuedTranscript.message, queuedTranscript.sender);
    }

    if (routingMode === "local-only") {
        state.sponsorBlockStatus = "disabled";
        const deliverable = immediatelyDeliverableLocalSegments(state);
        if (deliverable.length) {
            await sendSegments(
                tabId,
                videoId,
                deliverable,
                localDetectionSource(state),
            );
        } else if (uncertainLocalSegments(state).length) {
            console.log(
                `Local-only detection for ${videoId} is waiting for LLM verification`,
            );
        } else {
            console.log(`Local-only mode enabled for ${videoId}; waiting for transcript detection results`);
        }
        void maybeRunLlm(tabId, state);
        return;
    }

    try {
        const segments = await fetchSponsorBlockSegments(videoId);
        if (!isCurrent(tabId, videoId, generation)) return;

        state.sponsorBlockStatus = segments.length > 0 ? "hit" : "miss";
        if (segments.length > 0) {
            await sendSegments(tabId, videoId, segments, "sponsorblock");
        } else if (routingMode === "local-fallback") {
            const deliverable = immediatelyDeliverableLocalSegments(state);
            if (deliverable.length) {
                await sendSegments(
                    tabId,
                    videoId,
                    deliverable,
                    "local-fallback",
                );
            }
        } else if (routingMode === "sponsorblock-only") {
            console.log(
                state.llmFallbackEnabled
                    ? `No SponsorBlock entry for ${videoId}; waiting for the LLM fallback transcript`
                    : `No SponsorBlock entry for ${videoId}; SponsorBlock-only mode has no fallback`,
            );
        } else {
            console.log(`No SponsorBlock entry for ${videoId}; waiting for local transcript detection results`);
        }
        void maybeRunLlm(tabId, state);
    } catch (error) {
        if (!isCurrent(tabId, videoId, generation)) return;
        state.sponsorBlockStatus = "error";
        if (routingMode === "sponsorblock-only") {
            console.warn(
                state.llmFallbackEnabled
                    ? `SponsorBlock lookup failed for ${videoId}; waiting for LLM fallback`
                    : `SponsorBlock lookup failed for ${videoId}; SponsorBlock-only mode has no fallback`,
                error,
            );
        } else {
            console.warn(`SponsorBlock lookup failed for ${videoId}; using local detection`, error);
        }
        if (routingMode === "local-fallback") {
            const deliverable = immediatelyDeliverableLocalSegments(state);
            if (deliverable.length) {
                await sendSegments(
                    tabId,
                    videoId,
                    deliverable,
                    "local-fallback",
                );
            }
        }
        void maybeRunLlm(tabId, state);
    }
}

async function updateVideoChannel(tabId, videoId, channelHandle) {
    const state = tabState.get(tabId);
    if (!state || state.videoId !== videoId) return;
    const normalized = normalizedChannelHandle(channelHandle);
    if (!normalized || normalized === state.channelHandle) return;
    state.channelHandle = normalized;
    try {
        if (await isChannelBlocked(normalized)) {
            state.llmController?.abort();
            state.sponsorBlockStatus = "blocked";
            state.routingMode = "blocked";
            state.llmStatus = "disabled";
            state.pendingLocalSegments = null;
            state.transcriptEvents = null;
            await sendSegments(tabId, videoId, [], "reset");
            console.log(`Stopped sponsor scanning for blocked channel ${normalized} on ${videoId}`);
        }
    } catch (error) {
        console.warn("Unable to read blocked channel settings after channel update", error);
    }
}

function normalSourcesNeedLlm(state) {
    if (state.sponsorBlockStatus === "hit") return false;
    const localDetectionCompleted = Array.isArray(state.pendingLocalSegments);
    if (state.routingMode === "local-only") {
        return localResultNeedsLlm(state);
    }
    if (state.routingMode === "local-fallback") {
        return ["miss", "error"].includes(state.sponsorBlockStatus)
            && (
                localResultNeedsLlm(state)
                || (!localDetectionCompleted && state.transcriptEvents?.length)
            );
    }
    return state.routingMode === "sponsorblock-only"
        && ["miss", "error"].includes(state.sponsorBlockStatus);
}

async function runCachedLlmJob(state, controller, job) {
    const cacheKey = createLlmCacheKey({
        videoId: state.videoId,
        events: job.events,
        endpoint: state.llmEndpoint,
        model: state.llmModel,
        candidateSegments: job.candidates,
    });
    let segments;
    try {
        segments = await readCachedLlmResult(
            chrome.storage.local,
            cacheKey,
        );
    } catch (error) {
        console.warn(
            `Could not read the LLM cache for ${state.videoId}; requesting a fresh result`,
            error,
        );
        segments = null;
    }

    if (segments === null) {
        segments = await detectSponsorSegmentsWithLlm(
            job.events,
            {
                endpoint: state.llmEndpoint,
                apiKey: state.llmApiKey,
                model: state.llmModel,
                signal: controller.signal,
                candidateSegments: job.candidates,
                candidateContextMs: job.candidateContextMs,
            },
        );
        try {
            await writeCachedLlmResult(
                chrome.storage.local,
                cacheKey,
                segments,
            );
        } catch (error) {
            console.warn(
                `Could not save the LLM cache for ${state.videoId}`,
                error,
            );
        }
    } else {
        console.log(
            `LLM cache hit for ${state.videoId} (${segments.length} segment(s))`,
        );
    }
    return segments;
}

function normalizeLlmResults(state, segments) {
    return normalizeSegments(
        segments.map(segment => ({
            ...segment,
            model: state.llmModel,
            autoSkip: true,
        })),
        "llm-fallback",
    );
}

async function maybeRunLlm(tabId, state) {
    if (!state.llmFallbackEnabled
        || state.llmStatus !== "waiting"
        || !state.transcriptEvents?.length
        || !normalSourcesNeedLlm(state)) {
        return;
    }

    const runId = `${state.generation}:llm:${Date.now()}`;
    const controller = new AbortController();
    const plan = buildLlmPlan(state);
    state.llmStatus = "running";
    state.llmRunId = runId;
    state.llmController = controller;
    console.log(
        plan.kind === "candidate-verification"
            ? `LLM verifying ${plan.jobs.length} uncertain local segment(s) for ${state.videoId}`
            : plan.kind === "short-verification"
                ? `LLM verifying ${plan.jobs.length} short local segment(s) for ${state.videoId}`
                : `LLM fallback scanning transcript for ${state.videoId}`,
    );

    try {
        const acceptedLlmSegments = [];
        let rejectedUnrelatedCount = 0;
        for (const job of plan.jobs) {
            const rawSegments = await runCachedLlmJob(
                state,
                controller,
                job,
            );
            const normalized = normalizeLlmResults(state, rawSegments);
            if (job.candidates.length === 0) {
                acceptedLlmSegments.push(...normalized);
                continue;
            }
            const matching = normalized.filter(segment =>
                job.candidates.some(candidate =>
                    llmRangeMatchesCandidate(candidate, segment)));
            rejectedUnrelatedCount += normalized.length - matching.length;
            acceptedLlmSegments.push(...matching);
        }

        if (!isCurrent(tabId, state.videoId, state.generation)
            || state.llmRunId !== runId
            || state.sponsorBlockStatus === "hit") {
            return;
        }
        state.llmStatus = "complete";
        const normalizedLlm = normalizeSegments(
            acceptedLlmSegments,
            "llm-fallback",
        );
        const combined = combineVerifiedLlmSegments(
            state,
            normalizedLlm,
            plan,
        );
        console.log(
            plan.kind === "fallback"
                ? `LLM fallback found ${normalizedLlm.length} segment(s) for ${state.videoId}`
                : `LLM verification accepted ${normalizedLlm.length} segment(s) for ${state.videoId}`,
            normalizedLlm,
        );
        if (rejectedUnrelatedCount > 0) {
            console.warn(
                `Ignored ${rejectedUnrelatedCount} LLM segment(s) unrelated to local candidates for ${state.videoId}`,
            );
        }
        const shouldSend = plan.kind === "candidate-verification"
            ? combined.length > 0
            : normalizedLlm.length > 0;
        if (shouldSend) {
            await sendSegments(
                tabId,
                state.videoId,
                combined,
                "llm-fallback",
            );
        }
    } catch (error) {
        if (controller.signal.aborted) return;
        if (!isCurrent(tabId, state.videoId, state.generation)
            || state.llmRunId !== runId) {
            return;
        }
        state.llmStatus = "error";
        console.error(`LLM fallback failed for ${state.videoId}: ${error.message}`);
        const certainLocalSegments = state.pendingLocalSegments?.filter(
            segment => segment.confidence === "high",
        ) ?? [];
        if (certainLocalSegments.length) {
            await sendSegments(
                tabId,
                state.videoId,
                certainLocalSegments,
                localDetectionSource(state),
            );
        }
    } finally {
        if (state.llmRunId === runId) {
            state.llmController = null;
        }
    }
}

// scan a transcript
function scanTranscript(message, sender) {
    const tabId = sender.tab?.id;
    const {videoId, data} = message;
    if (!Number.isInteger(tabId) || typeof videoId !== "string" || typeof data !== "string") return;

    const state = tabState.get(tabId);
    if (!state || state.videoId !== videoId) return;
    if (state.routingMode === "loading") {
        state.queuedTranscript = {message, sender};
        return;
    }
    if (!allowsTranscriptProcessing(state)
        || state.sponsorBlockStatus === "hit") {
        return;
    }
    if (state.lastTranscriptData === data) return;
    state.lastTranscriptData = data;
    if (state.llmFallbackEnabled) {
        state.llmController?.abort();
        state.llmStatus = "waiting";
        state.llmRunId = null;
        state.llmController = null;
    }

    const scanId = `${state.generation}:${Date.now()}`;
    state.latestScanId = scanId;
    queueMicrotask(() => {
        try {
            const events = parseTranscript(data);
            if (!isCurrent(tabId, videoId, state.generation)
                || state.latestScanId !== scanId) {
                return;
            }
            state.transcriptEvents = events;
            if (allowsLocalDetection(state)) {
                state.localTranscriptStatus = "scanning";
                console.log(`Local detection scanning transcript for videoId: ${videoId}`);
                const segments = detectSponsorSegments(events);
                acceptLocalResult({tabId, videoId, scanId, segments});
                console.log(`Local detection found ${segments.length} segment(s) for ${videoId}`, segments);
            } else {
                void maybeRunLlm(tabId, state);
            }
        } catch (error) {
            console.error(`Local transcript scan failed for ${videoId}`, error);
        }
    });
}

function reportTranscriptStatus(message, sender) {
    const tabId = sender.tab?.id;
    const {videoId, status, reason = ""} = message;
    if (!Number.isInteger(tabId)
        || typeof videoId !== "string"
        || typeof status !== "string") {
        return;
    }

    const state = tabState.get(tabId);
    if (!state
        || state.videoId !== videoId
        || !allowsTranscriptProcessing(state)
        || state.sponsorBlockStatus === "hit") {
        return;
    }

    const statusKey = `${status}:${reason}`;
    if (state.localTranscriptStatus === statusKey) return;
    state.localTranscriptStatus = statusKey;

    if (status === "unavailable") {
        console.warn(`Transcript unavailable for ${videoId}: ${reason || "no transcript was exposed"}`);
    } else if (status === "fetch-error") {
        console.error(`Could not fetch the transcript for ${videoId}: ${reason || "unknown error"}`);
    } else {
        console.log(`Transcript status for ${videoId}: ${status}${reason ? ` (${reason})` : ""}`);
    }
}

function acceptLocalResult(message) {
    const {tabId, videoId, scanId} = message;
    const state = tabState.get(tabId);
    if (!state
        || state.videoId !== videoId
        || state.latestScanId !== scanId
        || !allowsLocalDetection(state)
        || state.sponsorBlockStatus === "hit") {
        return;
    }

    const source = localDetectionSource(state);
    state.pendingLocalSegments = normalizeSegments(
        message.segments ?? [],
        source,
    );
    const deliverable = immediatelyDeliverableLocalSegments(state);
    if (deliverable.length
        && state.sponsorBlockStatus !== "pending") {
        sendSegments(tabId, videoId, deliverable, source).catch(error => {
            console.error(error)
        });
    }
    if (localResultNeedsLlm(state)) {
        void maybeRunLlm(tabId, state);
    }
}

async function adjustSkipStats(message, direction) {
    const durationSeconds = Number(message.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;

    const stored = await chrome.storage.local.get({
        stats: {skippedSegments: 0, time: 0},
    });
    const currentStats = stored.stats ?? {};
    await chrome.storage.local.set({
        stats: {
            skippedSegments: Math.max(0, (Number(currentStats.skippedSegments) || 0) + direction),
            time: Math.max(0, (Number(currentStats.time) || 0) + (durationSeconds * direction)),
        },
    });
}

function queueSkipStatsUpdate(message, direction) {
    skipStatsUpdateQueue = skipStatsUpdateQueue
        .then(() => adjustSkipStats(message, direction))
        .catch(error => {
            console.error("Could not update skip stats", error);
        });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "VIDEO_CHANGED") {
        const tabId = sender.tab?.id;
        if (Number.isInteger(tabId) && typeof message.videoId === "string") {
            beginVideo(tabId, message.videoId, message.channelHandle).catch(error => {
                console.error(error)
            });
        }
    } else if (message.action === "CHANNEL_CHANGED") {
        const tabId = sender.tab?.id;
        if (Number.isInteger(tabId) && typeof message.videoId === "string") {
            updateVideoChannel(tabId, message.videoId, message.channelHandle).catch(error => {
                console.error(error);
            });
        }
    } else if (message.action === "PROCESS_TRANSCRIPT") {
        scanTranscript(message, sender);
    } else if (message.action === "TRANSCRIPT_STATUS") {
        reportTranscriptStatus(message, sender);
    } else if (message.action === "RECORD_SKIP_STATS") {
        queueSkipStatsUpdate(message, 1);
    } else if (message.action === "REVERT_SKIP_STATS") {
        queueSkipStatsUpdate(message, -1);
    } else if (message.action === "LIST_LLM_MODELS") {
        listLlmModels({
            endpoint: message.endpoint,
            apiKey: message.apiKey,
        }).then(models => {
            sendResponse({ok: true, models});
        }).catch(error => {
            sendResponse({ok: false, error: error.message});
        });
        return true;
    }
});

function stopAllDetection() {
    for (const [tabId, state] of tabState) {
        state.llmController?.abort();
        tabState.delete(tabId);
        void sendSegments(tabId, state.videoId, [], "reset");
    }
}

chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local"
        && changes.toggleExtension
        && changes.toggleExtension.newValue === false) {
        stopAllDetection();
    }
});

chrome.tabs.onRemoved.addListener(tabId => {
    tabState.get(tabId)?.llmController?.abort();
    tabState.delete(tabId);
});
