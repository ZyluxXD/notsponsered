import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const interceptorSource = await readFile(new URL("../interceptor.js", import.meta.url), "utf8");
const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));

function transcriptBody(text = "This video is sponsored by Acme.") {
    return JSON.stringify({
        events: [{
            tStartMs: 1_000,
            dDurationMs: 4_000,
            segs: [{utf8: text}],
        }],
    });
}

function playerResponse(videoId, baseUrl) {
    return {
        videoDetails: {videoId},
        captions: {
            playerCaptionsTracklistRenderer: {
                captionTracks: [{
                    languageCode: "en",
                    kind: "asr",
                    baseUrl,
                }],
            },
        },
    };
}

function createHarness(captionBody = transcriptBody()) {
    const postedMessages = [];
    const fetchCalls = [];
    const windowListeners = new Map();
    const body = captionBody;
    let adPlaying = false;

    const captionResponse = {
        ok: true,
        status: 200,
        async text() {
            return body;
        },
        clone() {
            return this;
        },
    };

    async function originalFetch(resource) {
        fetchCalls.push(String(resource));
        return captionResponse;
    }

    class FakeRequest {
        constructor(url) {
            this.url = url;
        }
    }

    class FakeXMLHttpRequest {
        constructor() {
            this.listeners = new Map();
            this.response = null;
            this.responseText = "";
            this.responseType = "";
        }

        addEventListener(type, listener) {
            const listeners = this.listeners.get(type) ?? [];
            listeners.push(listener);
            this.listeners.set(type, listeners);
        }

        open(method, url) {
            this.method = method;
            this.url = url;
        }

        send() {
            for (const listener of this.listeners.get("load") ?? []) listener.call(this);
        }
    }

    const location = {
        href: "https://www.youtube.com/watch?v=relative-video",
        origin: "https://www.youtube.com",
        pathname: "/watch",
    };
    const windowObject = {
        fetch: originalFetch,
        ytInitialPlayerResponse: playerResponse("relative-video", "/api/timedtext?v=relative-video"),
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) ?? [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
        postMessage(message) {
            postedMessages.push(message);
        },
    };
    const document = {
        querySelector(selector) {
            if (selector.includes(".ad-showing") || selector.includes(".ad-interrupting")) {
                return adPlaying ? {} : null;
            }
            return null;
        },
    };

    const context = vm.createContext({
        console,
        document,
        Error,
        Map,
        Request: FakeRequest,
        Set,
        String,
        URL,
        XMLHttpRequest: FakeXMLHttpRequest,
        location,
        setTimeout,
        window: windowObject,
    });
    vm.runInContext(interceptorSource, context, {filename: "interceptor.js"});

    function setCaptureEnabled(enabled) {
        for (const listener of windowListeners.get("message") ?? []) {
            listener({
                source: windowObject,
                data: {type: "SET_YT_TRANSCRIPT_CAPTURE", enabled},
            });
        }
    }

    setCaptureEnabled(true);

    return {
        FakeXMLHttpRequest,
        body,
        fetchCalls,
        postedMessages,
        setAdPlaying(value) {
            adPlaying = Boolean(value);
        },
        windowObject,
        dispatchRequest(videoId) {
            for (const listener of windowListeners.get("message") ?? []) {
                listener({
                    source: windowObject,
                    data: {type: "REQUEST_YT_TRANSCRIPT", videoId},
                });
            }
        },
    };
}

async function flushAsyncWork() {
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
}

test("installs the interceptor in MAIN world before the isolated content script", () => {
    assert.equal(manifest.content_scripts[0].world, "MAIN");
    assert.deepEqual(manifest.content_scripts[0].js, ["interceptor.js"]);
    assert.equal(manifest.content_scripts[0].run_at, "document_start");
    assert.equal(manifest.content_scripts[1].world, "ISOLATED");
    assert.deepEqual(manifest.content_scripts[1].js, ["content.js"]);
    assert.equal(manifest.content_scripts[1].run_at, "document_start");
    assert.equal(manifest.action.default_popup, "popup/popup.html");
    assert.ok(manifest.permissions.includes("storage"));
    assert.deepEqual(manifest.optional_host_permissions, ["*://*/*"]);
    assert.doesNotMatch(
        manifest.content_security_policy.extension_pages,
        /wasm-unsafe-eval/,
    );
});

test("declares valid extension and toolbar icons at every supported size", async () => {
    const expectedIcons = {
        "16": "assets/icons/icon-16.png",
        "32": "assets/icons/icon-32.png",
        "48": "assets/icons/icon-48.png",
        "128": "assets/icons/icon-128.png",
    };

    assert.deepEqual(manifest.icons, expectedIcons);
    assert.deepEqual(manifest.action.default_icon, expectedIcons);

    for (const [declaredSize, iconPath] of Object.entries(expectedIcons)) {
        const png = await readFile(new URL(`../${iconPath}`, import.meta.url));
        assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
        assert.equal(png.readUInt32BE(16), Number(declaredSize));
        assert.equal(png.readUInt32BE(20), Number(declaredSize));
    }
});

test("accepts relative caption URLs and replays a cached transcript on revisit", async () => {
    const harness = createHarness();

    harness.dispatchRequest("relative-video");
    await flushAsyncWork();

    const deliveries = harness.postedMessages.filter(message =>
        message.type === "YT_TRANSCRIPT_INTERCEPTED");
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].payload.videoId, "relative-video");
    assert.equal(deliveries[0].payload.data, harness.body);
    assert.equal(harness.fetchCalls.length, 1);
    assert.match(harness.fetchCalls[0], /^https:\/\/www\.youtube\.com\/api\/timedtext\?/);
    assert.match(harness.fetchCalls[0], /[?&]fmt=json3(?:&|$)/);

    harness.dispatchRequest("relative-video");
    await flushAsyncWork();

    assert.equal(harness.postedMessages.filter(message =>
        message.type === "YT_TRANSCRIPT_INTERCEPTED").length, 2);
    assert.equal(harness.fetchCalls.length, 1);
});

test("captures SPA player responses delivered through XMLHttpRequest", async () => {
    const harness = createHarness();
    const xhr = new harness.FakeXMLHttpRequest();
    xhr.responseType = "json";
    xhr.response = playerResponse("xhr-video", "/api/timedtext?v=xhr-video");

    xhr.open("POST", "https://www.youtube.com/youtubei/v1/player");
    xhr.send();
    await flushAsyncWork();

    const delivery = harness.postedMessages.find(message =>
        message.type === "YT_TRANSCRIPT_INTERCEPTED"
        && message.payload.videoId === "xhr-video");
    assert.ok(delivery);
    assert.equal(delivery.payload.data, harness.body);
    assert.match(harness.fetchCalls.at(-1), /[?&]v=xhr-video(?:&|$)/);
});

test("ignores timedtext traffic that cannot represent the current video", async () => {
    const xmlHarness = createHarness(
        "<transcript><text>ordinary caption response</text></transcript>",
    );

    await xmlHarness.windowObject.fetch(
        "https://www.youtube.com/api/timedtext?v=xml-video",
    );
    await flushAsyncWork();

    assert.equal(xmlHarness.postedMessages.some(message =>
        message.type === "YT_TRANSCRIPT_STATUS"
        && message.payload.videoId === "xml-video"), false);

    const adHarness = createHarness();
    adHarness.setAdPlaying(true);

    await adHarness.windowObject.fetch(
        "https://www.youtube.com/api/timedtext?v=relative-video&fmt=json3",
    );
    await flushAsyncWork();

    assert.equal(adHarness.postedMessages.some(message =>
        message.type === "YT_TRANSCRIPT_INTERCEPTED"), false);

    const idHarness = createHarness();

    await idHarness.windowObject.fetch("https://www.youtube.com/api/timedtext?fmt=json3");
    await idHarness.windowObject.fetch(
        "https://www.youtube.com/api/timedtext?v=advertisement-video&fmt=json3",
    );
    await flushAsyncWork();

    assert.equal(idHarness.postedMessages.some(message =>
        message.type === "YT_TRANSCRIPT_INTERCEPTED"), false);
});
