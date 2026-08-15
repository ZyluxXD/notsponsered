// default detection options
export const DEFAULT_OPTIONS = Object.freeze({
    maxSegmentMs: 180_000,
    minSegmentMs: 8_000,
    evidenceWindowMs: 50_000,
    startSearchBackMs: 30_000,
    maxSpanEvents: 4,
    maxSpanMs: 8_000,
    mergeGapMs: 8_000,
    stayWindowMs: 20_000,
    stayScore: 3,
    strongSignalGraceMs: 12_000,
    endPendingAfterMs: 8_000,
    noEvidenceTimeoutMs: 15_000,
    explicitStartNoEvidenceTimeoutMs: 30_000,
    explicitStartInitialEvidenceTimeoutMs: 60_000,
    selfPromotionNoEvidenceTimeoutMs: 150_000,
    unmarkedTailMs: 4_000,
    topicLookbackMs: 30_000,
    topicWindowMs: 9_000,
    topicCosineThreshold: 0.24,
    topicJaccardThreshold: 0.16,
    brandWindowMs: 90_000,
    evidenceEntryScore: 12,
    includeMetadata: false,
    includedCategories: [
        "paid-sponsor",
        "affiliate",
        "commercial-unknown",
        "self-promotion",
    ],
});

// groups that usually have high precision finding sponsors
export const HIGH_PRECISION_GROUPS = new Set([
    "code",
    "offer",
    "url",
    "legal",
]);

// how much each signal counts towards
export const SIGNAL_WEIGHTS = Object.freeze({
    sponsor: 3,
    code: 5,
    offer: 4,
    url: 5,
    cta: 2,
    legal: 7,
    pitch: 1,
    affiliate: 4,
    brand: 3,
});

// how much each negative signal counts against
export const NEGATIVE_WEIGHTS = Object.freeze({
    explicitNegation: 12,
    exampleOrMeta: 6,
    productDiscussion: 3,
});

// confidence rank enum
export const CONFIDENCE_RANK = Object.freeze({
    low: 0,
    medium: 1,
    high: 2,
});

// function that returns all default value options
export function withDefaults(options = {}) {
    return {
        ...DEFAULT_OPTIONS,
        ...options,
        includedCategories: options.includedCategories
            ? [...options.includedCategories]
            : [...DEFAULT_OPTIONS.includedCategories],
    };
}
