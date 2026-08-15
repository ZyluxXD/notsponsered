import {LLM_DETECTOR_VERSION, normalizeLlmEndpoint,} from "./llm-detector.js";

// version markings to avoid cache errors while testing
// so that if I update the cache code, the old cache will be invalidated
// and won't cause potential collisions or anything
export const LLM_CACHE_STORAGE_KEY = "llm-cache-v1";
export const LLM_CACHE_MAX_ENTRIES = 100;
export const LLM_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;


function normalizedEventLine(event) {
    const startMs = Number(event?.startMs);
    const endMs = Number(event?.endMs);
    const text = String(event?.text ?? "").replace(/\s+/g, " ").trim();
    return `${startMs}\t${endMs}\t${text}`;
}

// scary looking function
// but it's for creating cache keys
function cacheHash(value) {
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b); // JetBrains thought 'ebca' was a typo
    }
    return [first, second]
        .map(part => (part >>> 0).toString(16).padStart(8, "0"))
        .join("");
}

// function to create the cache key
export function createLlmCacheKey({
                                      videoId,
                                      events,
                                      endpoint,
                                      model,
                                      candidateSegments = [],
                                  }) {
    const identity = [
        LLM_DETECTOR_VERSION,
        String(videoId ?? "").trim(),
        normalizeLlmEndpoint(endpoint),
        String(model ?? "").trim(),
        ...events.map(normalizedEventLine),
        "local-candidates",
        ...candidateSegments
            .map(segment => [
                Number(segment?.startMs),
                Number(segment?.endMs),
                String(segment?.confidence ?? ""),
            ].join("\t"))
            .sort(),
    ].join("\n");
    return `${LLM_DETECTOR_VERSION}:${cacheHash(identity)}`;
}

// normalize a cached segment and return null if its invalid
function normalizedCachedSegment(segment) {
    const startMs = Number(segment?.startMs);
    const endMs = Number(segment?.endMs);
    const confidence = String(segment?.confidence ?? "");
    const category = String(segment?.category ?? "");
    const reason = String(segment?.reason ?? "").slice(0, 160);
    if (!Number.isFinite(startMs)
        || !Number.isFinite(endMs)
        || startMs < 0
        || endMs <= startMs
        || !["medium", "high"].includes(confidence)
        || !["paid-sponsor", "affiliate", "self-promotion"].includes(category)) {
        return null;
    }
    return {startMs, endMs, confidence, category, reason};
}

// filter out invalid entries from the cache and return only valid ones
function validEntries(value, now) {
    if (!Array.isArray(value)) return [];
    return value.filter(entry =>
        entry
        && typeof entry.key === "string"
        && Number.isFinite(entry.createdAt)
        && now - entry.createdAt >= 0
        && now - entry.createdAt <= LLM_CACHE_MAX_AGE_MS
        && Array.isArray(entry.segments));
}

// read the cached LLM result for a given cache key
export async function readCachedLlmResult(
    storage,
    cacheKey,
    {now = Date.now()} = {},
) {
    const stored = await storage.get({[LLM_CACHE_STORAGE_KEY]: []});
    const entries = validEntries(stored[LLM_CACHE_STORAGE_KEY], now);
    const entry = entries.find(candidate => candidate.key === cacheKey);
    if (!entry) return null;

    const segments = entry.segments
        .map(normalizedCachedSegment)
        .filter(Boolean);
    if (segments.length !== entry.segments.length) return null;
    return segments.map(segment => ({...segment}));
}

let writeQueue = Promise.resolve();

// write a cached LLM result for a given cache key
export function writeCachedLlmResult(
    storage,
    cacheKey,
    segments,
    {now = Date.now()} = {},
) {
    const cleanSegments = segments
        .map(normalizedCachedSegment)
        .filter(Boolean);
    if (cleanSegments.length !== segments.length) {
        return Promise.reject(new Error(`Discarding invalid cache segments (${cleanSegments.length} !== ${segments.length})`));
    }

    // write the cache result to the key's value
    const write = async () => {
        const stored = await storage.get({[LLM_CACHE_STORAGE_KEY]: []});
        const entries = validEntries(stored[LLM_CACHE_STORAGE_KEY], now)
            .filter(entry => entry.key !== cacheKey);
        entries.push({
            key: cacheKey,
            createdAt: now,
            segments: cleanSegments,
        });
        await storage.set({
            [LLM_CACHE_STORAGE_KEY]:
                entries.slice(-LLM_CACHE_MAX_ENTRIES),
        });
    };

    writeQueue = writeQueue.catch(() => {
    }).then(write);
    return writeQueue;
}
