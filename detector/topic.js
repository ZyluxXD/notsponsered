import {normalizeText} from "./text.js";
import {COMMERCIAL_WORDS, STOP_WORDS} from "./patterns.js";


// extract meaningful tokens from a text
function meaningfulTokens(text) {
    const counts = new Map();
    for (
        const token
        of normalizeText(text).match(/[a-z][a-z0-9-]{2,}/g) ?? []
        ) {
        if (STOP_WORDS.has(token) || COMMERCIAL_WORDS.has(token)) continue;
        counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    return counts;
}

// build a topic index from events
export function buildTopicIndex(events) {
    const documentFrequency = new Map();
    for (const event of events) {
        for (const token of meaningfulTokens(event.text).keys()) {
            documentFrequency.set(
                token,
                (documentFrequency.get(token) ?? 0) + 1,
            );
        }
    }

    const inverseFrequency = new Map();
    for (const [token, frequency] of documentFrequency) {
        inverseFrequency.set(
            token,
            Math.log((events.length + 1) / (frequency + 1)) + 1,
        );
    }

    function vectorBetween(startMs, endMs) {
        const counts = new Map();
        for (const event of events) {
            if (event.endMs < startMs || event.startMs > endMs) continue;
            for (const [token, count] of meaningfulTokens(event.text)) {
                counts.set(token, (counts.get(token) ?? 0) + count);
            }
        }

        const vector = new Map();
        for (const [token, count] of counts) {
            const importance = inverseFrequency.get(token) ?? 1;
            vector.set(token, (1 + Math.log(count)) * importance);
        }
        return vector;
    }

    return {vectorBetween};
}

// find the vector similarity between two vectors
export function vectorSimilarity(leftVector, rightVector) {
    if (!leftVector.size || !rightVector.size) {
        return {cosine: 0, weightedJaccard: 0, overlapTokens: 0};
    }

    let dot = 0;
    let normLeft = 0;
    let normRight = 0;
    let intersection = 0;
    let union = 0;
    let overlapTokens = 0;
    const keys = new Set([
        ...leftVector.keys(),
        ...rightVector.keys(),
    ]);

    for (const key of keys) {
        const left = leftVector.get(key) ?? 0;
        const right = rightVector.get(key) ?? 0;
        dot += left * right;
        normLeft += left * left;
        normRight += right * right;
        intersection += Math.min(left, right);
        union += Math.max(left, right);
        if (left > 0 && right > 0) overlapTokens++;
    }

    return {
        cosine: normLeft && normRight
            ? dot / Math.sqrt(normLeft * normRight)
            : 0,
        weightedJaccard: union ? intersection / union : 0,
        overlapTokens,
    };
}

// check if the pre-sponsor topic has returned to the video
export function topicHasReturned(
    topicIndex,
    preSponsorTopic,
    events,
    currentIndex,
    options,
) {
    if (!preSponsorTopic.size) return false;
    const endMs = events[currentIndex].endMs;
    const currentTopic = topicIndex.vectorBetween(
        endMs - options.topicWindowMs,
        endMs,
    );
    const similarity = vectorSimilarity(preSponsorTopic, currentTopic);

    return similarity.overlapTokens >= 2
        && similarity.cosine >= options.topicCosineThreshold
        && similarity.weightedJaccard >= options.topicJaccardThreshold;
}
