import assert from "node:assert/strict";
import test from "node:test";
import {
    chatCompletionsUrl,
    chunkTranscriptEvents,
    detectSponsorSegmentsWithLlm,
    endpointPermissionPattern,
    listLlmModels,
    llmRangeMatchesCandidate,
    modelsUrl,
    parseLlmSegments,
} from "../detector/llm-detector.js";

const events = [
    {startMs: 0, endMs: 8_000, text: "The aircraft reaches the runway."},
    {startMs: 8_000, endMs: 16_000, text: "All this travel reminds me that I need mobile data."},
    {startMs: 16_000, endMs: 24_000, text: "This video's sponsor provides eSIM plans in many countries."},
    {startMs: 24_000, endMs: 32_000, text: "Use the QR code and discount code shown on screen."},
    {startMs: 32_000, endMs: 40_000, text: "Now back to the aircraft."},
];

test("builds OpenAI-compatible endpoint URLs without hardcoded model routing", () => {
    assert.equal(
        chatCompletionsUrl("https://provider.example/v1/"),
        "https://provider.example/v1/chat/completions",
    );
    assert.equal(
        modelsUrl("https://provider.example/v1/chat/completions"),
        "https://provider.example/v1/models",
    );
    assert.equal(
        endpointPermissionPattern("http://localhost:11434/v1"),
        "http://localhost/*",
    );
});

test("loads the model dropdown data from the provider models endpoint", async () => {
    const calls = [];
    const models = await listLlmModels({
        endpoint: "https://provider.example/v1",
        apiKey: "secret",
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            return {
                ok: true,
                async json() {
                    return {
                        data: [
                            {id: "provider-large"},
                            {id: "provider-small"},
                            {id: "provider-large"},
                        ],
                    };
                },
            };
        },
    });

    assert.deepEqual(models, ["provider-large", "provider-small"]);
    assert.equal(calls[0].url, "https://provider.example/v1/models");
    assert.equal(calls[0].options.headers.Authorization, "Bearer secret");
});

test("uses global transcript event IDs and accepts a bounded LLM range", async () => {
    const calls = [];
    const segments = await detectSponsorSegmentsWithLlm(events, {
        endpoint: "https://provider.example/v1",
        apiKey: "secret",
        model: "provider-model",
        candidateSegments: [{
            startMs: 8_000,
            endMs: 32_000,
            confidence: "medium",
        }],
        fetchImpl: async (url, options) => {
            calls.push({url, options});
            return {
                ok: true,
                async json() {
                    return {
                        choices: [{
                            message: {
                                content: "```json\n{\"segments\":[{\"start_event\":1,\"end_event\":4,\"confidence\":\"high\",\"category\":\"paid-sponsor\",\"reason\":\"sponsor disclosure and discount code\"}]}\n```",
                            },
                        }],
                    };
                },
            };
        },
    });

    assert.deepEqual(segments, [{
        startMs: 8_000,
        endMs: 32_000,
        confidence: "high",
        category: "paid-sponsor",
        reason: "sponsor disclosure and discount code",
    }]);
    assert.equal(
        calls[0].url,
        "https://provider.example/v1/chat/completions",
    );
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.model, "provider-model");
    assert.equal(body.temperature, 0.1);
    assert.match(body.messages[0].content, /untrusted quoted data/i);
    assert.match(body.messages[0].content, /never say "sponsor"/i);
    assert.match(body.messages[0].content, /weak hints/i);
    assert.match(body.messages[1].content, /\[1\] 8\.000-16\.000/);
    assert.match(body.messages[1].content, /medium local confidence/i);
});

test("rejects hallucinated event IDs and unsupported categories", () => {
    const [chunk] = chunkTranscriptEvents(events);
    const segments = parseLlmSegments({
        choices: [{
            message: {
                content: JSON.stringify({
                    segments: [
                        {
                            start_event: -20,
                            end_event: 3,
                            confidence: "high",
                            category: "paid-sponsor",
                        },
                        {
                            start_event: 1,
                            end_event: 4,
                            confidence: "high",
                            category: "ordinary-review",
                        },
                    ],
                }),
            },
        }],
    }, events, chunk);

    assert.deepEqual(segments, []);
});

test("requires meaningful candidate overlap instead of accepting a grazing range", () => {
    const candidate = {startMs: 100_000, endMs: 140_000};
    assert.equal(llmRangeMatchesCandidate(candidate, {
        startMs: 90_000,
        endMs: 160_000,
    }), true);
    assert.equal(llmRangeMatchesCandidate(candidate, {
        startMs: 110_000,
        endMs: 116_000,
    }), true);
    assert.equal(llmRangeMatchesCandidate(candidate, {
        startMs: 139_500,
        endMs: 180_000,
    }), false);
    assert.equal(llmRangeMatchesCandidate(candidate, {
        startMs: 140_000,
        endMs: 150_000,
    }), false);
});

const longEvents = Array.from({length: 18}, (_, index) => ({
    startMs: index * 30_000,
    endMs: (index + 1) * 30_000,
    text: `Transcript event ${index} ${"context ".repeat(10)}`,
}));

function llmPayload(segments) {
    return {
        choices: [{
            message: {content: JSON.stringify({segments})},
        }],
    };
}

test("overlaps long transcript chunks by time instead of a few caption events", () => {
    const chunks = chunkTranscriptEvents(longEvents, {
        maxCharacters: 650,
    });

    assert.ok(chunks.length > 1);
    for (let index = 1; index < chunks.length; index++) {
        const previous = chunks[index - 1];
        const current = chunks[index];
        const previousEndMs = longEvents[previous.endIndex - 1].endMs;
        const currentStartMs = longEvents[current.startIndex].startMs;
        assert.ok(current.startIndex < previous.endIndex);
        assert.ok(
            previousEndMs - currentStartMs >= 90_000,
            `expected at least 90 seconds of overlap at chunk ${index}`,
        );
    }
});

test("repairs a sponsor range that reaches a chunk seam", async () => {
    let boundaryEvent = null;
    let seamRepairCalls = 0;
    const segments = await detectSponsorSegmentsWithLlm(longEvents, {
        endpoint: "https://provider.example/v1",
        model: "provider-model",
        chunkOptions: {maxCharacters: 650},
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            const prompt = body.messages[1].content;
            const eventIds = [...prompt.matchAll(/\[(\d+)]/g)]
                .map(match => Number(match[1]));
            let responseSegments = [];
            if (/Re-inspect this transcript window/.test(prompt)) {
                seamRepairCalls++;
                responseSegments = [{
                    start_event: boundaryEvent - 2,
                    end_event: boundaryEvent + 3,
                    confidence: "high",
                    category: "paid-sponsor",
                    reason: "complete sponsor read across the seam",
                }];
            } else if (boundaryEvent === null) {
                boundaryEvent = eventIds.at(-1) + 1;
                responseSegments = [{
                    start_event: boundaryEvent - 2,
                    end_event: boundaryEvent,
                    confidence: "medium",
                    category: "paid-sponsor",
                    reason: "promotion continues at the chunk edge",
                }];
            }
            return {
                ok: true,
                async json() {
                    return llmPayload(responseSegments);
                },
            };
        },
    });

    assert.equal(seamRepairCalls, 1);
    assert.deepEqual(segments, [{
        startMs: longEvents[boundaryEvent - 2].startMs,
        endMs: longEvents[boundaryEvent + 3].startMs,
        confidence: "high",
        category: "paid-sponsor",
        reason: "complete sponsor read across the seam",
    }]);
});

test("drops an edge-only false positive when seam repair rejects it", async () => {
    let returnedEdgeResult = false;
    let seamRepairCalls = 0;
    const segments = await detectSponsorSegmentsWithLlm(longEvents, {
        endpoint: "https://provider.example/v1",
        model: "provider-model",
        chunkOptions: {maxCharacters: 650},
        fetchImpl: async (_url, options) => {
            const body = JSON.parse(options.body);
            const prompt = body.messages[1].content;
            const eventIds = [...prompt.matchAll(/\[(\d+)]/g)]
                .map(match => Number(match[1]));
            let responseSegments = [];
            if (/Re-inspect this transcript window/.test(prompt)) {
                seamRepairCalls++;
            } else if (!returnedEdgeResult) {
                returnedEdgeResult = true;
                const endEvent = eventIds.at(-1) + 1;
                responseSegments = [{
                    start_event: endEvent - 2,
                    end_event: endEvent,
                    confidence: "medium",
                    category: "paid-sponsor",
                    reason: "ordinary product discussion at an edge",
                }];
            }
            return {
                ok: true,
                async json() {
                    return llmPayload(responseSegments);
                },
            };
        },
    });

    assert.equal(seamRepairCalls, 1);
    assert.deepEqual(segments, []);
});
