import {CONFIDENCE_RANK, withDefaults} from "./config.js";
import {featureForText} from "./features.js";
import {buildSpanAnalysis} from "./spans.js";
import {addRepeatedBrandEvidence} from "./brands.js";
import {evidenceWindows} from "./evidence.js";
import {buildTopicIndex} from "./topic.js";
import {collectCandidate} from "./boundaries.js";

// compare confidence ranks, return stronger one
function strongerConfidence(left, right) {
    return CONFIDENCE_RANK[left] >= CONFIDENCE_RANK[right] ? left : right;
}

// merge categories
function mergeCategory(left, right) {
    if (left === right) return left;
    if (left === "paid-sponsor" || right === "paid-sponsor") {
        return "paid-sponsor";
    }
    if (left === "commercial-unknown") return right;
    if (right === "commercial-unknown") return left;
    return "mixed-commercial";
}

// merge segments
function mergeSegments(segments, options) {
    const merged = [];
    for (const segment of [...segments].sort((a, b) =>
        a.startMs - b.startMs)) {
        const previous = merged.at(-1);
        const mergedDuration = previous
            ? Math.max(previous.endMs, segment.endMs)
            - Math.min(previous.startMs, segment.startMs)
            : Infinity;

        if (
            previous
            && segment.startMs - previous.endMs <= options.mergeGapMs
            && mergedDuration <= options.maxSegmentMs
        ) {
            previous.endMs = Math.max(previous.endMs, segment.endMs);
            previous.confidence = strongerConfidence(
                previous.confidence,
                segment.confidence,
            );
            previous.category = mergeCategory(
                previous.category,
                segment.category,
            );
            previous.reason = [...new Set(
                `${previous.reason}+${segment.reason}+merged`.split("+"),
            )].join("+");
            previous.score = Math.max(previous.score, segment.score);
            previous.groups = [...new Set([
                ...previous.groups,
                ...segment.groups,
            ])].sort();
            previous.brands = [...new Set([
                ...previous.brands,
                ...segment.brands,
            ])].sort();
        } else {
            merged.push({...segment});
        }
    }
    return merged;
}

// detector of sponsored segments
export function detectSponsorSegments(events, detectorOptions = {}) {
    if (!Array.isArray(events) || events.length === 0) return [];
    const options = withDefaults(detectorOptions);
    const sortedEvents = events
        .map(event => ({
            startMs: Number(event.startMs),
            endMs: Number(event.endMs),
            text: String(event.text ?? ""),
        }))
        .filter(event =>
            Number.isFinite(event.startMs)
            && Number.isFinite(event.endMs)
            && event.endMs >= event.startMs
            && event.text.trim())
        .sort((a, b) =>
            a.startMs - b.startMs
            || a.endMs - b.endMs
            || a.text.localeCompare(b.text))
        .filter((event, index, all) => {
            const previous = all[index - 1];
            return !previous
                || event.startMs !== previous.startMs
                || event.endMs !== previous.endMs
                || event.text !== previous.text;
        });
    if (!sortedEvents.length) return [];

    const baseFeatures = sortedEvents.map(event =>
        featureForText(event.text));
    const spanAnalysis = buildSpanAnalysis(
        sortedEvents,
        baseFeatures,
        options,
    );
    const features = spanAnalysis.features;
    addRepeatedBrandEvidence(sortedEvents, features, options);

    const seeds = spanAnalysis.startSpans.map(span => ({
        startIndex: span.startIndex,
        endIndex: span.endIndex,
        kind: "explicit-start",
        score: span.feature.score,
    }));
    seeds.push(...evidenceWindows(sortedEvents, features, options));
    seeds.sort((left, right) =>
        left.startIndex - right.startIndex
        || Number(right.kind === "explicit-start")
        - Number(left.kind === "explicit-start")
        || (right.score ?? 0) - (left.score ?? 0));
    if (!seeds.length) return [];

    const topicIndex = buildTopicIndex(sortedEvents);
    const candidates = [];
    for (const seed of seeds) {
        const seedTime = sortedEvents[seed.startIndex].startMs;
        if (candidates.some(candidate =>
            seedTime >= sortedEvents[candidate.startIndex].startMs
            && seedTime <= (
                candidate.endMs
                ?? sortedEvents[candidate.endIndex].endMs
            ))) {
            continue;
        }

        const candidate = collectCandidate(
            sortedEvents,
            features,
            spanAnalysis,
            seed,
            topicIndex,
            options,
        );
        if (candidate) candidates.push(candidate);
    }

    const includedCategories = new Set(options.includedCategories);
    const segments = candidates
        .map(candidate => ({
            startMs: sortedEvents[candidate.startIndex].startMs,
            endMs: candidate.endMs
                ?? sortedEvents[candidate.endIndex].endMs,
            confidence: candidate.confidence,
            category: candidate.category,
            reason: candidate.reason,
            score: candidate.score,
            groups: candidate.groups,
            brands: candidate.brands,
        }))
        .filter(segment => {
            const duration = segment.endMs - segment.startMs;
            return duration >= options.minSegmentMs
                && duration <= options.maxSegmentMs
                && includedCategories.has(segment.category);
        });

    const merged = mergeSegments(segments, options);

    if (options.includeMetadata) {
        return merged;
    }

    return merged.map(segment => ({
        startMs: segment.startMs,
        endMs: segment.endMs,
        confidence: segment.confidence,
        reason: segment.reason,
    }));
}
