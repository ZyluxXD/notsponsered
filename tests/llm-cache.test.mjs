import assert from "node:assert/strict";
import test from "node:test";
import {
    createLlmCacheKey,
    LLM_CACHE_MAX_AGE_MS,
    LLM_CACHE_MAX_ENTRIES,
    LLM_CACHE_STORAGE_KEY,
    readCachedLlmResult,
    writeCachedLlmResult,
} from "../detector/llm-cache.js";
import {LLM_DETECTOR_VERSION} from "../detector/llm-detector.js";

const events = [
    {startMs: 0, endMs: 8_000, text: "The aircraft reaches the runway."},
    {startMs: 8_000, endMs: 16_000, text: "Use the link to request a demo."},
];
const segments = [{
    startMs: 8_000,
    endMs: 16_000,
    confidence: "high",
    category: "paid-sponsor",
    reason: "commercial call to action",
}];

function createStorage() {
    const values = {};
    return {
        values,
        async get(defaults) {
            return {...defaults, ...values};
        },
        async set(patch) {
            Object.assign(values, patch);
        },
    };
}

function cacheKey(overrides = {}) {
    return createLlmCacheKey({
        videoId: "video-one",
        events,
        endpoint: "https://provider.example/v1",
        model: "provider-model",
        ...overrides,
    });
}

test("cache keys change with the video, transcript, endpoint, or model", () => {
    const original = cacheKey();
    assert.match(original, new RegExp(`^${LLM_DETECTOR_VERSION}:`));
    assert.equal(
        original,
        cacheKey({endpoint: "https://provider.example/v1/"}),
    );
    assert.notEqual(original, cacheKey({videoId: "video-two"}));
    assert.notEqual(original, cacheKey({model: "another-model"}));
    assert.notEqual(original, cacheKey({
        events: [
            events[0],
            {...events[1], text: "The transcript has changed."},
        ],
    }));
    assert.notEqual(
        original,
        cacheKey({endpoint: "https://another.example/v1"}),
    );
    assert.notEqual(original, cacheKey({
        candidateSegments: [{
            startMs: 8_000,
            endMs: 16_000,
            confidence: "medium",
        }],
    }));
});

test("stores both detected segments and empty successful results", async () => {
    const storage = createStorage();
    const detectedKey = cacheKey();
    const emptyKey = cacheKey({videoId: "empty-video"});

    await writeCachedLlmResult(storage, detectedKey, segments, {now: 1_000});
    await writeCachedLlmResult(storage, emptyKey, [], {now: 2_000});

    assert.deepEqual(
        await readCachedLlmResult(storage, detectedKey, {now: 3_000}),
        segments,
    );
    assert.deepEqual(
        await readCachedLlmResult(storage, emptyKey, {now: 3_000}),
        [],
    );
});

test("expires old results and bounds the persistent cache", async () => {
    const storage = createStorage();
    const firstKey = cacheKey({videoId: "video-0"});

    for (let index = 0; index < LLM_CACHE_MAX_ENTRIES + 2; index++) {
        await writeCachedLlmResult(
            storage,
            cacheKey({videoId: `video-${index}`}),
            [],
            {now: index + 1},
        );
    }

    assert.equal(
        storage.values[LLM_CACHE_STORAGE_KEY].length,
        LLM_CACHE_MAX_ENTRIES,
    );
    assert.equal(
        await readCachedLlmResult(
            storage,
            firstKey,
            {now: LLM_CACHE_MAX_ENTRIES + 3},
        ),
        null,
    );

    const newestKey = cacheKey({
        videoId: `video-${LLM_CACHE_MAX_ENTRIES + 1}`,
    });
    assert.deepEqual(
        await readCachedLlmResult(storage, newestKey, {
            now: LLM_CACHE_MAX_AGE_MS + LLM_CACHE_MAX_ENTRIES + 2,
        }),
        [],
    );
    assert.equal(
        await readCachedLlmResult(storage, newestKey, {
            now: LLM_CACHE_MAX_AGE_MS + LLM_CACHE_MAX_ENTRIES + 3,
        }),
        null,
    );
});
