import assert from "node:assert/strict";
import test from "node:test";

const hostConsole = globalThis.console;
globalThis.console = Object.assign(Object.create(hostConsole), {
    log() {
    }
});

let messageListener;
let storageChangeListener;
const delivered = [];
let fetchResponse;
let fetchCount;
let localOnlyMode;
let routingMode;
let startTrimSeconds;
let endTrimSeconds;
let llmFallbackEnabled;
let llmEndpoint;
let llmApiKey;
let llmModel;
let toggleExtension;
let llmFetchCount;
const llmRequestBodies = [];
let llmResponse;
const storedValues = {};
let backgroundInstance = 0;

async function installFreshBackgroundHarness() {
    messageListener = null;
    storageChangeListener = null;
    delivered.length = 0;
    fetchResponse = {status: 404, ok: false};
    fetchCount = 0;
    localOnlyMode = false;
    routingMode = null;
    startTrimSeconds = 3;
    endTrimSeconds = 3;
    llmFallbackEnabled = false;
    llmEndpoint = "https://provider.example/v1";
    llmApiKey = "secret";
    llmModel = "provider-model";
    toggleExtension = true;
    llmFetchCount = 0;
    llmRequestBodies.length = 0;
    llmResponse = {
        status: 200,
        ok: true,
        payload: {
            choices: [{
                message: {content: "{\"segments\":[]}"},
            }],
        },
    };
    for (const key of Object.keys(storedValues)) delete storedValues[key];

    globalThis.chrome = {
        runtime: {
            onMessage: {
                addListener(listener) {
                    messageListener = listener;
                },
            },
        },
        tabs: {
            async sendMessage(tabId, message) {
                delivered.push({tabId, message});
            },
            onRemoved: {
                addListener() {
                },
            },
        },
        storage: {
            local: {
                async get(defaults = {}) {
                    return {
                        ...defaults,
                        ...storedValues,
                        routingMode,
                        localOnly: localOnlyMode,
                        startTrimSeconds,
                        endTrimSeconds,
                        llmFallbackEnabled,
                        llmEndpoint,
                        llmApiKey,
                        llmModel,
                        toggleExtension,
                    };
                },
                async set(values) {
                    Object.assign(storedValues, values);
                },
            },
            onChanged: {
                addListener(listener) {
                    storageChangeListener = listener;
                },
            },
        },
    };

    globalThis.fetch = async (url, options = {}) => {
        fetchCount++;
        if (String(url).includes("/chat/completions")) {
            llmFetchCount++;
            llmRequestBodies.push(JSON.parse(options.body));
            return {
                ...llmResponse,
                async json() {
                    return llmResponse.payload;
                },
            };
        }
        return {
            ...fetchResponse,
            async json() {
                return fetchResponse.payload;
            },
        };
    };

    await import(`../background.js?test=${backgroundInstance++}`);
}

test.beforeEach(installFreshBackgroundHarness);

function transcript(events) {
    return JSON.stringify({
        events: events.map(([startMs, durationMs, text]) => ({
            tStartMs: startMs,
            dDurationMs: durationMs,
            segs: [{utf8: text}],
        })),
    });
}

async function flushAsyncWork() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

test("use the local fallback after a SponsorBlock miss", async () => {
    messageListener({action: "VIDEO_CHANGED", videoId: "local-video"}, {tab: {id: 42}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "local-video",
        data: transcript([
            [100_000, 8_000, "Before we continue, here is a quick word from Acme."],
            [108_000, 11_000, "Head over to acme.com/alex and start your free trial today."],
            [119_000, 13_000, "Use promo code ALEX for 20 percent off your first order."],
            [132_000, 6_000, "Thanks to Acme for supporting the show. Now let's get back to the story."],
        ]),
    }, {tab: {id: 42}});
    await flushAsyncWork();

    const finalDelivery = delivered.at(-1);
    assert.equal(finalDelivery.message.source, "local-fallback");
    assert.equal(
        finalDelivery.message.segments[0].source,
        "local-fallback",
    );
    assert.deepEqual(finalDelivery.message.segments.map(({startMs, endMs}) => ({startMs, endMs})), [{
        startMs: 103_000,
        endMs: 135_000,
    }]);
});

test("records and reverts skip stats in local storage", async () => {
    storedValues.stats = {skippedSegments: 2, time: 45};

    messageListener({
        action: "RECORD_SKIP_STATS",
        durationSeconds: 12.5,
    }, {tab: {id: 42}});
    await flushAsyncWork();

    assert.deepEqual(storedValues.stats, {
        skippedSegments: 3,
        time: 57.5,
    });

    messageListener({
        action: "REVERT_SKIP_STATS",
        durationSeconds: 12.5,
    }, {tab: {id: 42}});
    await flushAsyncWork();

    assert.deepEqual(storedValues.stats, {
        skippedSegments: 2,
        time: 45,
    });

    delete storedValues.stats;
});

test("does not do detection while the global extension switch is toggled off", async () => {
    toggleExtension = false;
    routingMode = "local-fallback";

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "extension-disabled-video",
    }, {tab: {id: 141}});
    await flushAsyncWork();

    assert.deepEqual(
        delivered.map(item => item.message.source),
        ["reset"],
    );
    assert.equal(fetchCount, 0);

    toggleExtension = true;
    routingMode = null;
});

test("turning the extension off cancels detection in the active tab", async () => {
    routingMode = "local-only";

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "extension-switch-video",
    }, {tab: {id: 144}});
    await flushAsyncWork();

    toggleExtension = false;
    storageChangeListener({
        toggleExtension: {oldValue: true, newValue: false},
    }, "local");
    await flushAsyncWork();
    const deliveriesAfterDisable = delivered.length;

    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "extension-switch-video",
        data: transcript([
            [10_000, 10_000, "This video is sponsored by Acme."],
            [20_000, 10_000, "Use code TEST for twenty percent off."],
        ]),
    }, {tab: {id: 144}});
    await flushAsyncWork();

    assert.equal(delivered.at(-1).message.source, "reset");
    assert.equal(delivered.length, deliveriesAfterDisable);

    toggleExtension = true;
    routingMode = null;
});

test("stops scanning when a blocked channel handle is reported after video start", async () => {
    storedValues.blockedChannelHandles = ["@late-channel"];
    routingMode = "local-only";

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "late-channel-video",
    }, {tab: {id: 143}});
    await flushAsyncWork();
    messageListener({
        action: "CHANNEL_CHANGED",
        videoId: "late-channel-video",
        channelHandle: "@late-channel",
    }, {tab: {id: 143}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "late-channel-video",
        data: transcript([
            [50_000, 8_000, "Before we continue, here is a quick word from Acme."],
            [58_000, 10_000, "Visit acme.com/test and use promo code TEST for 20 percent off."],
        ]),
    }, {tab: {id: 143}});
    await flushAsyncWork();

    assert.equal(fetchCount, 0);
    assert.equal(
        delivered.filter(item => item.message.source !== "reset").length,
        0,
    );

    routingMode = null;
    delete storedValues.blockedChannelHandles;
});

test("prefers SponsorBlock and ignores a later transcript", async () => {
    llmFallbackEnabled = true;
    fetchResponse = {
        status: 200,
        ok: true,
        payload: [{
            segment: [12.5, 44.25],
            category: "sponsor",
            actionType: "skip",
        }],
    };

    messageListener({action: "VIDEO_CHANGED", videoId: "community-video"}, {tab: {id: 7}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "community-video",
        data: transcript([
            [100_000, 10_000, "This video is sponsored by Acme."],
            [110_000, 10_000, "Use promo code TEST for 20 percent off."],
        ]),
    }, {tab: {id: 7}});
    await flushAsyncWork();

    const nonResetDeliveries = delivered.filter(item => item.message.source !== "reset");
    assert.equal(nonResetDeliveries.length, 1);
    assert.equal(nonResetDeliveries[0].message.source, "sponsorblock");
    assert.deepEqual(nonResetDeliveries[0].message.segments.map(({startMs, endMs}) => ({startMs, endMs})), [{
        startMs: 15_500,
        endMs: 41_250,
    }]);
    assert.equal(llmFetchCount, 0);
});

test("local-only mode never contacts SponsorBlock", async () => {
    routingMode = "local-only";
    fetchResponse = {
        status: 200,
        ok: true,
        payload: [{
            segment: [12.5, 44.25],
            category: "sponsor",
            actionType: "skip",
        }],
    };

    messageListener({action: "VIDEO_CHANGED", videoId: "local-only-video"}, {tab: {id: 13}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "local-only-video",
        data: transcript([
            [50_000, 8_000, "Before we continue, here is a quick word from Acme."],
            [58_000, 10_000, "Visit acme.com/test and use promo code TEST for 20 percent off."],
            [68_000, 7_000, "Thanks to Acme for supporting the show. Back to the video."],
        ]),
    }, {tab: {id: 13}});
    await flushAsyncWork();

    assert.equal(fetchCount, 0);
    const finalDelivery = delivered.at(-1);
    assert.equal(finalDelivery.message.source, "local-only");
    assert.equal(finalDelivery.message.segments[0].source, "local-only");
    assert.equal(finalDelivery.message.segments.length, 1);
    routingMode = null;
});

test("uses the LLM after SponsorBlock and local fallback both return no segments", async () => {
    routingMode = "local-fallback";
    llmFallbackEnabled = true;
    fetchResponse = {status: 404, ok: false};
    llmResponse = {
        status: 200,
        ok: true,
        payload: {
            choices: [{
                message: {
                    content: JSON.stringify({
                        segments: [{
                            start_event: 1,
                            end_event: 3,
                            confidence: "high",
                            category: "paid-sponsor",
                            reason: "commercial pitch missed by local detector",
                        }],
                    }),
                },
            }],
        },
    };

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "llm-after-double-miss-video",
    }, {tab: {id: 18}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "llm-after-double-miss-video",
        data: transcript([
            [0, 10_000, "The team opens the machine and checks the first reading."],
            [10_000, 10_000, "A short detour explains how the workflow changed this month."],
            [20_000, 10_000, "The new dashboard makes approvals and review cycles easier to track."],
            [30_000, 10_000, "After that, the team returns to the machine and starts the next pass."],
        ]),
    }, {tab: {id: 18}});
    await flushAsyncWork();

    const llmDelivery = delivered.find(item =>
        item.message.source === "llm-fallback");
    assert.ok(llmDelivery, "LLM fallback should deliver after both normal sources miss");
    assert.equal(llmFetchCount, 1);
    assert.equal(fetchCount, 2);
    assert.deepEqual(
        llmDelivery.message.segments.map(({startMs, endMs, source}) => ({
            startMs,
            endMs,
            source,
        })),
        [{startMs: 13_000, endMs: 27_000, source: "llm-fallback"}],
    );

    llmFallbackEnabled = false;
    routingMode = null;
});

test("requires LLM confirmation before delivering a medium local detection", async () => {
    routingMode = "local-only";
    llmFallbackEnabled = true;
    llmResponse = {
        status: 200,
        ok: true,
        payload: {
            choices: [{
                message: {content: "{\"segments\":[]}"},
            }],
        },
    };

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "medium-verification-video",
    }, {tab: {id: 81}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "medium-verification-video",
        data: transcript([
            [0, 8_000, "Before we continue, this video is sponsored by Acme."],
            [8_000, 8_000, "Acme organizes projects and approvals for your whole team."],
            [16_000, 8_000, "Visit acme.com and start a free trial using the link below."],
        ]),
    }, {tab: {id: 81}});
    await flushAsyncWork();

    assert.equal(llmFetchCount, 1);
    assert.equal(delivered.filter(item =>
        item.message.source !== "reset").length, 0);
    assert.equal(llmRequestBodies[0].temperature, 0.1);
    assert.match(
        llmRequestBodies[0].messages[1].content,
        /medium local confidence/i,
    );

    llmFallbackEnabled = false;
    routingMode = null;
});

test("replaces a low local detection with the LLM-verified range", async () => {
    routingMode = "local-only";
    llmFallbackEnabled = true;
    llmResponse = {
        status: 200,
        ok: true,
        payload: {
            choices: [{
                message: {
                    content: JSON.stringify({
                        segments: [{
                            start_event: 0,
                            end_event: 3,
                            confidence: "high",
                            category: "paid-sponsor",
                            reason: "sustained commercial pitch",
                        }],
                    }),
                },
            }],
        },
    };

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "low-verification-video",
    }, {tab: {id: 82}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "low-verification-video",
        data: transcript([
            [0, 8_000, "Running a business can be difficult and scattered."],
            [8_000, 8_000, "Acme organizes projects and approvals for your whole team."],
            [16_000, 8_000, "Visit acme.com and start a free trial using the link below."],
        ]),
    }, {tab: {id: 82}});
    await flushAsyncWork();

    assert.equal(llmFetchCount, 1);
    const nonResetDeliveries = delivered.filter(item =>
        item.message.source !== "reset");
    assert.equal(nonResetDeliveries.length, 1);
    assert.equal(nonResetDeliveries[0].message.source, "llm-fallback");
    assert.equal(nonResetDeliveries[0].message.segments[0].source, "llm-fallback");
    assert.deepEqual(
        nonResetDeliveries[0].message.segments.map(
            ({startMs, endMs}) => ({startMs, endMs}),
        ),
        [{startMs: 3_000, endMs: 21_000}],
    );
    assert.match(
        llmRequestBodies[0].messages[1].content,
        /low local confidence/i,
    );

    llmFallbackEnabled = false;
    routingMode = null;
});

test("does not call the LLM for a high-confidence local detection", async () => {
    routingMode = "local-only";
    llmFallbackEnabled = true;

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "high-no-verification-video",
    }, {tab: {id: 83}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "high-no-verification-video",
        data: transcript([
            [0, 10_000, "Before we continue, this video is sponsored by Acme."],
            [10_000, 10_000, "Visit acme.com and use code SAVE for 20 percent off."],
            [20_000, 10_000, "Thanks to Acme for supporting us. Back to the video."],
        ]),
    }, {tab: {id: 83}});
    await flushAsyncWork();

    assert.equal(llmFetchCount, 0);
    assert.equal(delivered.at(-1).message.source, "local-only");
    assert.equal(delivered.at(-1).message.segments[0].confidence, "high");

    llmFallbackEnabled = false;
    routingMode = null;
});

test("caches an empty LLM result so a no-match video is not billed twice", async () => {
    routingMode = "local-only";
    llmFallbackEnabled = true;
    llmResponse = {
        status: 200,
        ok: true,
        payload: {
            choices: [{
                message: {content: "{\"segments\":[]}"},
            }],
        },
    };
    const data = transcript([
        [0, 10_000, "The crew enters the workshop."],
        [10_000, 10_000, "They inspect the damaged engine."],
    ]);

    for (const tabId of [73, 74]) {
        messageListener({
            action: "VIDEO_CHANGED",
            videoId: "cached-empty-llm-video",
        }, {tab: {id: tabId}});
        await flushAsyncWork();
        messageListener({
            action: "PROCESS_TRANSCRIPT",
            videoId: "cached-empty-llm-video",
            data,
        }, {tab: {id: tabId}});
        await flushAsyncWork();
    }

    assert.equal(llmFetchCount, 1);
    assert.equal(delivered.filter(item =>
        item.message.source === "llm-fallback").length, 0);

    llmFallbackEnabled = false;
    routingMode = null;
});

test("does not use saved LLM fields while the LLM fallback switch is off", async () => {
    routingMode = "local-only";

    messageListener({
        action: "VIDEO_CHANGED",
        videoId: "llm-disabled-video",
    }, {tab: {id: 16}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "llm-disabled-video",
        data: transcript([
            [0, 10_000, "The team enters the workshop."],
            [10_000, 10_000, "They inspect the first machine."],
        ]),
    }, {tab: {id: 16}});
    await flushAsyncWork();

    assert.equal(llmFetchCount, 0);
    assert.equal(fetchCount, 0);
    routingMode = null;
});

test("applies configured trims and falls back to matching defaults", async () => {
    fetchResponse = {
        status: 200,
        ok: true,
        payload: [{
            segment: [20, 40],
            category: "sponsor",
            actionType: "skip",
        }],
    };

    const scenarios = [
        {
            videoId: "custom-timing-video",
            tabId: 21,
            startTrim: 1.5,
            endTrim: 2.25,
            expected: {startMs: 21_500, endMs: 37_750},
        },
        {
            videoId: "default-timing-video",
            tabId: 22,
            startTrim: undefined,
            endTrim: undefined,
            expected: {startMs: 23_000, endMs: 37_000},
        },
    ];

    for (const scenario of scenarios) {
        startTrimSeconds = scenario.startTrim;
        endTrimSeconds = scenario.endTrim;
        delivered.length = 0;
        messageListener({
            action: "VIDEO_CHANGED",
            videoId: scenario.videoId,
        }, {tab: {id: scenario.tabId}});
        await flushAsyncWork();

        const finalDelivery = delivered.at(-1);
        assert.equal(finalDelivery.message.source, "sponsorblock");
        assert.deepEqual(
            finalDelivery.message.segments.map(({startMs, endMs}) => ({
                startMs,
                endMs,
            })),
            [scenario.expected],
        );
    }
});

test("does not rescan or resend an identical transcript", async () => {
    localOnlyMode = true;
    const data = transcript([
        [50_000, 8_000, "Before we continue, here is a quick word from Acme."],
        [58_000, 10_000, "Visit acme.com/test and use promo code TEST for 20 percent off."],
        [68_000, 7_000, "Thanks to Acme for supporting the show. Back to the video."],
    ]);

    messageListener({action: "VIDEO_CHANGED", videoId: "dedupe-video"}, {tab: {id: 31}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "dedupe-video",
        data,
    }, {tab: {id: 31}});
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "dedupe-video",
        data,
    }, {tab: {id: 31}});
    await flushAsyncWork();

    const localDeliveries = delivered.filter(item =>
        item.message.source === "local-only");
    assert.equal(localDeliveries.length, 1);
    localOnlyMode = false;
});

test("trims only the outer edges of clustered SponsorBlock ranges", async () => {
    fetchResponse = {
        status: 200,
        ok: true,
        payload: [
            {category: "sponsor", actionType: "skip", segment: [861.096, 869.757]},
            {category: "sponsor", actionType: "skip", segment: [873.43, 880.707]},
            {category: "sponsor", actionType: "skip", segment: [885.884, 893.842]},
            {category: "sponsor", actionType: "skip", segment: [902.977, 911.926]},
            {category: "sponsor", actionType: "skip", segment: [918.694, 945.537]},
            {category: "sponsor", actionType: "skip", segment: [947.157, 949.837]},
        ],
    };

    messageListener({action: "VIDEO_CHANGED", videoId: "fragmented-community-video"}, {tab: {id: 55}});
    await flushAsyncWork();

    const finalDelivery = delivered.at(-1);
    assert.equal(finalDelivery.message.source, "sponsorblock");
    assert.deepEqual(
        finalDelivery.message.segments.map(({startMs, endMs}) => ({startMs, endMs})),
        [
            {startMs: 864_096, endMs: 869_757},
            {startMs: 873_430, endMs: 880_707},
            {startMs: 885_884, endMs: 893_842},
            {startMs: 902_977, endMs: 911_926},
            {startMs: 918_694, endMs: 945_537},
        ],
    );
});

test("SponsorBlock-only mode delivers community hits without local fallback", async () => {
    routingMode = "sponsorblock-only";
    fetchResponse = {status: 404, ok: false};

    messageListener({action: "VIDEO_CHANGED", videoId: "community-only-video"}, {tab: {id: 61}});
    await flushAsyncWork();
    messageListener({
        action: "PROCESS_TRANSCRIPT",
        videoId: "community-only-video",
        data: transcript([
            [50_000, 8_000, "Before we continue, here is a quick word from Acme."],
            [58_000, 10_000, "Visit acme.com/test and use promo code TEST for 20 percent off."],
            [68_000, 7_000, "Thanks to Acme for supporting the show. Back to the video."],
        ]),
    }, {tab: {id: 61}});
    await flushAsyncWork();

    assert.equal(fetchCount, 1);
    assert.equal(delivered.filter(item =>
        item.message.source === "local-fallback").length, 0);

    delivered.length = 0;
    fetchCount = 0;
    fetchResponse = {
        status: 200,
        ok: true,
        payload: [{
            segment: [25, 55],
            category: "sponsor",
            actionType: "skip",
        }],
    };

    messageListener({action: "VIDEO_CHANGED", videoId: "community-only-hit"}, {tab: {id: 62}});
    await flushAsyncWork();

    assert.equal(fetchCount, 1);
    assert.equal(delivered.at(-1).message.source, "sponsorblock");
    assert.equal(delivered.at(-1).message.segments.length, 1);
});
