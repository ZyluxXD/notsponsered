import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const contentSource = await readFile(
    new URL("../content.js", import.meta.url),
    "utf8",
);

class FakeElement {
    constructor(tagName = "div") {
        this.tagName = String(tagName).toUpperCase();
        this.id = "";
        this.attributes = new Map();
        this.children = [];
        this.listeners = new Map();
        this.queries = new Map();
        this.parentElement = null;
        this.currentTime = 0;
        this.duration = Number.NaN;
        this.playbackRate = 1;
        this.paused = false;
        this.playCalls = 0;
        this.pauseCalls = 0;
        this.isConnected = false;
        this.className = "";
        this.textContent = "";
        this.style = {
            setProperty(name, value) {
                this[name] = String(value);
            },
        };
        this.clientWidth = 0;
        this.clientHeight = 0;
    }

    setAttribute(name, value) {
        const normalizedValue = String(value);
        this.attributes.set(name, normalizedValue);
        if (name === "id") this.id = normalizedValue;
    }

    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    appendChild(child) {
        child.parentElement = this;
        child.isConnected = true;
        this.children.push(child);
        return child;
    }

    remove() {
        this.isConnected = false;
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children
                .filter(child => child !== this);
        }
        this.parentElement = null;
    }

    querySelector(selector) {
        if (!this.queries.has(selector)) {
            this.queries.set(selector, new FakeElement("span"));
        }
        return this.queries.get(selector);
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    removeEventListener(type, listener) {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter(item => item !== listener),
        );
    }

    getBoundingClientRect() {
        return {
            width: this.clientWidth,
            height: this.clientHeight,
        };
    }

    play() {
        this.playCalls++;
        this.paused = false;
        return Promise.resolve();
    }

    pause() {
        this.pauseCalls++;
        this.paused = true;
    }

    dispatch(type) {
        const event = {
            type,
            target: this,
            propagationStopped: false,
            stopPropagation() {
                this.propagationStopped = true;
            },
        };
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
        return event;
    }
}

function createHarness(
    routingMode = "local-fallback",
    llmFallbackEnabled = false,
    initialExtensionEnabled = true,
    initialAdAutoSkipEnabled = true,
) {
    const windowListeners = new Map();
    const intervals = new Map();
    const animationFrames = new Map();
    const timeouts = new Map();
    const sentMessages = [];
    const consoleLogs = [];
    let runtimeListener;
    let storageChangeListener;
    let extensionEnabled = initialExtensionEnabled;
    let adAutoSkipEnabled = initialAdAutoSkipEnabled;
    let adPlaying = false;
    let nextTimerId = 1;
    const resizeObservers = [];

    const head = new FakeElement("head");
    const player = new FakeElement("div");
    const video = new FakeElement("video");
    let progressBar = new FakeElement("div");
    video.parentElement = player;
    video.duration = 200;

    const documentElement = new FakeElement("html");
    const document = {
        head,
        documentElement,
        createElement(tagName) {
            return new FakeElement(tagName);
        },
        createElementNS(_namespace, tagName) {
            return new FakeElement(tagName);
        },
        getElementById(id) {
            const pending = [head, documentElement];
            while (pending.length) {
                const element = pending.shift();
                if (element.id === id) return element;
                pending.push(...element.children);
            }
            return null;
        },
        querySelector(selector) {
            if (selector.includes(".ad-showing")
                || selector.includes(".ad-interrupting")) {
                return adPlaying ? player : null;
            }
            if (selector === ".html5-video-player") return player;
            if (selector === ".ytp-progress-bar") return progressBar;
            if (selector === "video") return video;
            return null;
        },
    };
    const windowObject = {
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) ?? [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
        postMessage(message) {
            sentMessages.push(message);
        },
    };
    const chrome = {
        runtime: {
            onMessage: {
                addListener(listener) {
                    runtimeListener = listener;
                },
            },
            sendMessage(message) {
                sentMessages.push(structuredClone(message));
            },
        },
        storage: {
            local: {
                async get(defaults) {
                    return {
                        ...defaults,
                        routingMode,
                        llmFallbackEnabled,
                        toggleExtension: extensionEnabled,
                        adAutoSkipEnabled,
                    };
                },
            },
            onChanged: {
                addListener(listener) {
                    storageChangeListener = listener;
                },
            },
        },
    };

    const context = vm.createContext({
        cancelAnimationFrame(frameId) {
            animationFrames.delete(frameId);
        },
        chrome,
        clearInterval(timerId) {
            intervals.delete(timerId);
        },
        clearTimeout(timerId) {
            timeouts.delete(timerId);
        },
        console: {
            ...console,
            log(...args) {
                consoleLogs.push(args);
            },
        },
        document,
        location: {
            href: "https://www.youtube.com/watch?v=timeline-video",
            pathname: "/watch",
        },
        requestAnimationFrame(callback) {
            const frameId = nextTimerId++;
            animationFrames.set(frameId, callback);
            return frameId;
        },
        ResizeObserver: class {
            constructor(callback) {
                this.callback = callback;
                this.observedElements = new Set();
                resizeObservers.push(this);
            }

            observe(element) {
                this.observedElements.add(element);
            }

            disconnect() {
                this.observedElements.clear();
            }
        },
        setInterval(callback, delay) {
            const timerId = nextTimerId++;
            intervals.set(timerId, {callback, delay});
            return timerId;
        },
        setTimeout(callback, delay = 0) {
            const timerId = nextTimerId++;
            if (delay <= 300) callback();
            else timeouts.set(timerId, {callback, delay});
            return timerId;
        },
        URL,
        window: windowObject,
    });
    vm.runInContext(contentSource, context, {filename: "content.js"});

    function dispatchKeyboard(type, {repeat = false} = {}) {
        const event = {
            type,
            code: "Space",
            key: " ",
            repeat,
            defaultPrevented: false,
            immediatePropagationStopped: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
            stopPropagation() {
            },
            stopImmediatePropagation() {
                this.immediatePropagationStopped = true;
            },
        };
        for (const listener of windowListeners.get(type) ?? []) {
            listener(event);
            if (event.immediatePropagationStopped) break;
        }
        return event;
    }

    return {
        dispatchKeyboard,
        consoleLogs,
        player,
        sentMessages,
        get motionBlurFilter() {
            return document.getElementById("video-motion-blur-filter");
        },
        get skipBubble() {
            return player.children.find(child => child.className === "skip-bubble") ?? null;
        },
        get skipUndoNotice() {
            return player.children.find(child =>
                child.className.includes("skip-undo-bubble")) ?? null;
        },
        get adBubble() {
            return player.children.find(child =>
                child.className.includes("ad-bubble")) ?? null;
        },
        appendOrphanSkipBubble() {
            const bubble = new FakeElement("div");
            bubble.className = "skip-bubble";
            bubble.textContent = "Skipping sponsor";
            player.appendChild(bubble);
            return bubble;
        },
        setPlayerSize(width, height) {
            player.clientWidth = width;
            player.clientHeight = height;
            video.clientWidth = width;
            video.clientHeight = height;
        },
        setVideoSize(width, height) {
            video.clientWidth = width;
            video.clientHeight = height;
        },
        notifyResize(element) {
            for (const observer of resizeObservers) {
                if (observer.observedElements.has(element)) observer.callback();
            }
        },
        setAdPlaying(value) {
            adPlaying = value === true;
        },
        setSegments(segments, source = "local-fallback") {
            runtimeListener({
                action: "SET_SPONSOR_SEGMENTS",
                videoId: "timeline-video",
                source,
                segments,
            });
        },
        tickTimeline() {
            const timeline = [...intervals.values()]
                .find(interval => interval.delay === 250);
            assert.ok(timeline, "timeline interval should be registered");
            timeline.callback();
        },
        tickSkipUndoTimeout() {
            const timeoutEntry = [...timeouts.entries()]
                .find(([, timeout]) => timeout.delay === 8_000);
            assert.ok(timeoutEntry, "skip undo timeout should be registered");
            const [timerId, timeout] = timeoutEntry;
            timeouts.delete(timerId);
            timeout.callback();
        },
        tickAdBubbleTimeout() {
            const timeoutEntry = [...timeouts.entries()]
                .find(([, timeout]) => timeout.delay === 2_000);
            assert.ok(timeoutEntry, "ad bubble timeout should be registered");
            const [timerId, timeout] = timeoutEntry;
            timeouts.delete(timerId);
            timeout.callback();
        },
        video,
        windowObject,
        windowListeners,
        get overlay() {
            return player.children.find(child =>
                child.className === "skip-overlay-container") ?? null;
        },
        get progressBar() {
            return progressBar;
        },
        replaceProgressBar() {
            progressBar = new FakeElement("div");
        },
        async changeExtensionEnabled(enabled) {
            const oldValue = extensionEnabled;
            extensionEnabled = enabled;
            storageChangeListener({
                toggleExtension: {oldValue, newValue: enabled},
            }, "local");
            await new Promise(resolve => setTimeout(resolve, 0));
        },
        changeAdAutoSkipEnabled(enabled) {
            const oldValue = adAutoSkipEnabled;
            adAutoSkipEnabled = enabled;
            storageChangeListener({
                adAutoSkipEnabled: {oldValue, newValue: enabled},
            }, "local");
        },
    };
}

test("the global switch clears page behavior and reinitializes when enabled", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }]);
    harness.video.currentTime = 90;
    harness.tickTimeline();
    assert.ok(harness.overlay);

    harness.video.currentTime = 100;
    harness.tickTimeline();
    assert.equal(harness.video.playbackRate, 16);

    const videoMessagesBeforeDisable = harness.sentMessages.filter(message =>
        message.action === "VIDEO_CHANGED").length;
    await harness.changeExtensionEnabled(false);
    harness.tickTimeline();
    assert.equal(harness.overlay, null);
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
    assert.equal(
        harness.progressBar.children.some(child =>
            child.className === "notsponsored-timeline-highlights"),
        false,
    );

    await harness.changeExtensionEnabled(true);
    const videoMessagesAfterEnable = harness.sentMessages.filter(message =>
        message.action === "VIDEO_CHANGED").length;
    assert.equal(videoMessagesAfterEnable, videoMessagesBeforeDisable + 1);
});

test("auto-skips an active YouTube ad by seeking it to the end", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.video.currentTime = 12;
    harness.video.duration = 30;
    harness.setAdPlaying(true);

    harness.tickTimeline();

    assert.equal(harness.video.currentTime, 29.95);
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.playCalls, 1);
    assert.equal(harness.video.paused, false);
    assert.equal(harness.adBubble.textContent, "Ad skipped");
    assert.equal(harness.adBubble.getAttribute("role"), "status");
    assert.equal(harness.adBubble.getAttribute("aria-live"), "polite");

    const bubble = harness.adBubble;
    harness.tickAdBubbleTimeout();
    assert.match(bubble.className, /ad-bubble-exit/);
    bubble.dispatch("animationend");
    assert.equal(harness.adBubble, null);

    harness.tickTimeline();
    assert.equal(harness.adBubble, null);
    assert.equal(harness.video.playCalls, 1);

    harness.setAdPlaying(false);
    harness.tickTimeline();
    assert.equal(harness.video.paused, false);
    assert.equal(harness.video.pauseCalls, 0);
});

test("temporarily resumes a paused ad and restores pause after it ends", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.video.currentTime = 12;
    harness.video.duration = 30;
    harness.video.playbackRate = 1.5;
    harness.video.paused = true;
    harness.setAdPlaying(true);

    harness.tickTimeline();

    assert.equal(harness.video.currentTime, 29.95);
    assert.equal(harness.video.playbackRate, 1.5);
    assert.equal(harness.video.paused, false);
    assert.equal(harness.video.playCalls, 1);

    harness.setAdPlaying(false);
    harness.tickTimeline();

    assert.equal(harness.video.playbackRate, 1.5);
    assert.equal(harness.video.paused, true);
    assert.equal(harness.video.pauseCalls, 1);
});

test("does not report an ad skip when skipping is disabled or impossible", async () => {
    const scenarios = [
        {
            name: "auto-skip disabled",
            create: () => createHarness(
                "local-fallback",
                false,
                true,
                false,
            ),
            prepare(harness) {
                harness.video.duration = 30;
            },
            verifyReenable: true,
        },
        {
            name: "duration unavailable",
            create: () => createHarness(),
            prepare(harness) {
                harness.video.duration = Number.NaN;
            },
        },
        {
            name: "seek rejected",
            create: () => createHarness(),
            prepare(harness) {
                Object.defineProperty(harness.video, "currentTime", {
                    get() {
                        return 12;
                    },
                    set() {
                    },
                });
                harness.video.duration = 30;
            },
        },
    ];

    for (const scenario of scenarios) {
        const harness = scenario.create();
        await new Promise(resolve => setTimeout(resolve, 0));
        harness.video.currentTime = 12;
        scenario.prepare(harness);
        harness.setAdPlaying(true);
        harness.tickTimeline();

        assert.equal(harness.video.currentTime, 12, scenario.name);
        assert.equal(harness.video.playCalls, 0, scenario.name);
        assert.equal(harness.adBubble, null, scenario.name);

        if (scenario.verifyReenable) {
            harness.changeAdAutoSkipEnabled(true);
            harness.tickTimeline();
            assert.equal(harness.video.currentTime, 29.95);
            assert.equal(harness.video.playCalls, 1);
            assert.equal(harness.adBubble.textContent, "Ad skipped");
        }
    }
});

test("resumes an interrupted sponsor skip after a YouTube ad", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 20_000,
        endMs: 40_000,
        confidence: "high",
    }]);
    harness.video.currentTime = 25;
    harness.video.playbackRate = 1.5;
    harness.tickTimeline();

    assert.equal(harness.video.playbackRate, 16);
    assert.ok(harness.skipBubble);

    harness.setAdPlaying(true);
    harness.video.currentTime = 0;
    harness.video.duration = 30;
    harness.video.dispatch("seeking");
    harness.tickTimeline();

    assert.equal(harness.video.currentTime, 29.95);
    assert.equal(harness.video.playbackRate, 1.5);
    assert.equal(harness.skipBubble, null);
    assert.ok(harness.adBubble);

    harness.setAdPlaying(false);
    harness.video.duration = 200;
    harness.tickTimeline();

    // The ad's 29.95s timestamp is also inside the 20-40s sponsor range.
    assert.equal(harness.video.currentTime, 25);
    assert.equal(harness.video.playbackRate, 16);
    assert.ok(harness.skipBubble);

    harness.video.currentTime = 40;
    harness.video.dispatch("timeupdate");
    assert.equal(harness.video.playbackRate, 1.5);
    assert.ok(harness.skipUndoNotice);
    assert.equal(harness.sentMessages.filter(message =>
        message.action === "RECORD_SKIP_STATS").length, 1);
});

test("Space cancels the upcoming card without reaching YouTube keyboard handlers", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    let youtubeShortcutCalls = 0;
    harness.windowObject.addEventListener("keydown", () => {
        youtubeShortcutCalls++;
        harness.video.paused = !harness.video.paused;
    });
    harness.windowObject.addEventListener("keyup", () => {
        youtubeShortcutCalls++;
        harness.video.paused = !harness.video.paused;
    });
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }]);

    harness.video.currentTime = 90;
    harness.tickTimeline();
    assert.ok(harness.overlay);

    const keydown = harness.dispatchKeyboard("keydown");
    const keyup = harness.dispatchKeyboard("keyup");

    assert.equal(keydown.defaultPrevented, true);
    assert.equal(keyup.defaultPrevented, true);
    assert.equal(harness.overlay, null);
    assert.equal(youtubeShortcutCalls, 0);
    assert.equal(harness.video.paused, false);

    harness.dispatchKeyboard("keydown");
    assert.equal(youtubeShortcutCalls, 1);
});

test("labels local-only skips and completes the skip lifecycle", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }], "local-only");

    harness.video.currentTime = 90;
    harness.tickTimeline();

    assert.equal(
        harness.overlay.querySelector(".skip-source").textContent,
        "Source: Local only (high)",
    );

    harness.video.currentTime = 100;
    harness.tickTimeline();
    assert.equal(harness.consoleLogs.some(args =>
            args[0] === "Skipping video to 120.00s"), true,
        JSON.stringify(harness.consoleLogs));
    assert.equal(harness.video.playbackRate, 16);
    assert.equal(harness.skipBubble.textContent, "Skipping sponsor");
    assert.equal(harness.skipBubble.getAttribute("role"), "status");
    assert.deepEqual(harness.sentMessages.at(-1), {
        action: "RECORD_SKIP_STATS",
        durationSeconds: 20,
    });

    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
    assert.equal(harness.video.style.willChange, "");
    assert.equal(harness.skipBubble, null);
    assert.ok(harness.skipUndoNotice);
});

test("rescales an active upcoming card when only the video dimensions change", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setPlayerSize(1280, 720);
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }]);

    harness.video.currentTime = 90;
    harness.tickTimeline();
    assert.equal(harness.overlay.style.transform, "scale(1)");

    harness.setVideoSize(480, 270);
    harness.notifyResize(harness.video);

    assert.equal(harness.overlay.style.transform, "scale(0.58)");
});

test("undoes a completed sponsor skip and suppresses it for the video session", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }], "local-only");

    harness.video.currentTime = 100;
    harness.tickTimeline();
    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");

    const undoNotice = harness.skipUndoNotice;
    assert.ok(undoNotice);
    assert.equal(undoNotice.children[0].textContent, "Sponsor skipped");
    assert.equal(undoNotice.children[1].textContent, "Undo");
    undoNotice.children[1].dispatch("click");

    assert.equal(harness.video.currentTime, 100);
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.skipUndoNotice, null);
    assert.deepEqual(harness.sentMessages.at(-1), {
        action: "REVERT_SKIP_STATS",
        durationSeconds: 20,
    });

    harness.tickTimeline();
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.consoleLogs.filter(args =>
        args[0] === "Skipping video to 120.00s").length, 1);
});

test("does not restart an overlapping refreshed segment during or after undo", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }], "local-only");

    harness.video.currentTime = 100;
    harness.tickTimeline();
    assert.equal(harness.video.playbackRate, 16);

    harness.setSegments([{
        startMs: 98_000,
        endMs: 124_000,
        confidence: "high",
        model: "provider-model",
    }], "llm-fallback");
    harness.tickTimeline();
    assert.equal(harness.consoleLogs.filter(args =>
        String(args[0]).startsWith("Skipping video to")).length, 1);

    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");
    assert.equal(harness.video.playbackRate, 1);
    assert.ok(harness.skipUndoNotice);

    harness.tickTimeline();
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.consoleLogs.filter(args =>
        String(args[0]).startsWith("Skipping video to")).length, 1);

    const preUndoOrphan = harness.appendOrphanSkipBubble();
    harness.video.playbackRate = 16;
    harness.skipUndoNotice.children[1].dispatch("click");
    assert.equal(harness.video.currentTime, 100);
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
    assert.equal(harness.skipBubble, null);
    assert.equal(preUndoOrphan.isConnected, false);

    const lateOrphan = harness.appendOrphanSkipBubble();

    harness.tickTimeline();
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(lateOrphan.isConnected, false);
    assert.equal(harness.skipBubble, null);
    assert.equal(harness.consoleLogs.filter(args =>
        String(args[0]).startsWith("Skipping video to")).length, 1);
    assert.equal(harness.sentMessages.filter(message =>
        message.action === "RECORD_SKIP_STATS").length, 1);
});

test("expires the sponsor skip undo notice", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }], "local-only");

    harness.video.currentTime = 100;
    harness.tickTimeline();
    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");
    const undoNotice = harness.skipUndoNotice;
    assert.ok(undoNotice);
    assert.equal(undoNotice.className, "skip-bubble skip-undo-bubble");

    harness.tickSkipUndoTimeout();
    assert.match(undoNotice.className, /skip-bubble-exit/);
    assert.equal(undoNotice.isConnected, false);
    assert.equal(harness.skipUndoNotice, null);
});

test("injects one motion-blur filter and reuses it across skips", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([
        {
            startMs: 100_000,
            endMs: 120_000,
            confidence: "high",
        },
        {
            startMs: 140_000,
            endMs: 160_000,
            confidence: "high",
        },
    ], "local-only");

    harness.video.currentTime = 100;
    harness.tickTimeline();
    const firstFilter = harness.motionBlurFilter;
    assert.ok(firstFilter);

    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");
    harness.video.currentTime = 140;
    harness.tickTimeline();

    assert.equal(harness.motionBlurFilter, firstFilter);
    assert.equal(harness.video.playbackRate, 16);

    harness.video.currentTime = 160;
    harness.video.dispatch("seeking");
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
    assert.equal(harness.skipUndoNotice, null);
});

test("does not count a buffered skip attempt more than once", async () => {
    const harness = createHarness("local-fallback");
    await new Promise(resolve => setTimeout(resolve, 0));
    let bufferedTime = 100;
    Object.defineProperty(harness.video, "currentTime", {
        get() {
            return bufferedTime;
        },
        set() {
        },
    });
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }]);

    harness.tickTimeline();
    harness.tickTimeline();
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
    }]);
    harness.tickTimeline();

    assert.equal(harness.sentMessages.filter(message =>
        message.action === "RECORD_SKIP_STATS").length, 1);
    assert.equal(harness.video.playbackRate, 16);

    bufferedTime = 121;
    harness.video.dispatch("timeupdate");
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
});

test("automatically skips LLM fallback matches", async () => {
    const harness = createHarness("local-only");
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([{
        startMs: 100_000,
        endMs: 120_000,
        confidence: "high",
        model: "provider-model",
    }], "llm-fallback");

    harness.video.currentTime = 90;
    harness.tickTimeline();
    assert.ok(harness.overlay);
    assert.equal(
        harness.overlay.querySelector(".skip-source").textContent,
        "Source: LLM fallback — provider-model (high)",
    );

    harness.video.currentTime = 100;
    harness.tickTimeline();
    assert.equal(harness.video.currentTime, 100);
    assert.equal(harness.video.playbackRate, 16);
    assert.equal(harness.video.style.filter, "url(#video-motion-blur)");
    assert.equal(harness.consoleLogs.some(args =>
        args[0] === "Skipping video to 120.00s"), true);
    assert.equal(harness.overlay, null);

    harness.video.currentTime = 120;
    harness.video.dispatch("timeupdate");
    assert.equal(harness.video.playbackRate, 1);
    assert.equal(harness.video.style.filter, "");
});

test("SponsorBlock-only mode captures transcripts only for LLM fallback", async () => {
    for (const llmEnabled of [false, true]) {
        const harness = createHarness(
            "sponsorblock-only",
            llmEnabled,
        );
        await new Promise(resolve => setTimeout(resolve, 0));
        await new Promise(resolve => setTimeout(resolve, 0));

        assert.equal(harness.sentMessages.some(message =>
            message.type === "SET_YT_TRANSCRIPT_CAPTURE"
            && message.enabled === llmEnabled), true);
        assert.equal(harness.sentMessages.some(message =>
            message.type === "REQUEST_YT_TRANSCRIPT"), llmEnabled);
    }
});

test("keeps scrubber markers in sync through DOM and LLM replacements", async () => {
    const harness = createHarness();
    await new Promise(resolve => setTimeout(resolve, 0));
    harness.setSegments([
        {
            startMs: 20_000,
            endMs: 40_000,
            confidence: "medium",
        },
        {
            startMs: 100_000,
            endMs: 120_000,
            confidence: "high",
        },
    ]);

    const firstLayer = harness.progressBar.children.find(child =>
        child.className === "notsponsored-timeline-highlights");
    assert.ok(firstLayer);
    assert.equal(firstLayer.children.length, 2);

    harness.replaceProgressBar();
    harness.tickTimeline();

    const restoredLayer = harness.progressBar.children.find(child =>
        child.className === "notsponsored-timeline-highlights");
    assert.ok(restoredLayer);
    assert.equal(restoredLayer.children.length, 2);

    harness.setSegments([{
        startMs: 22_000,
        endMs: 38_000,
        confidence: "high",
        model: "provider-model",
    }], "llm-fallback");

    const llmLayer = harness.progressBar.children.find(child =>
        child.className === "notsponsored-timeline-highlights");
    assert.ok(llmLayer);
    assert.notEqual(llmLayer, restoredLayer);
    assert.equal(restoredLayer.isConnected, false);
    assert.equal(llmLayer.children.length, 1);

    harness.setSegments([], "llm-fallback");

    assert.equal(llmLayer.isConnected, false);
    assert.equal(harness.progressBar.children.some(child =>
        child.className === "notsponsored-timeline-highlights"), false);
});
