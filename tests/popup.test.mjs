import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const popupHtml = await readFile(
    new URL("../popup/popup.html", import.meta.url),
    "utf8",
);
const popupSource = await readFile(
    new URL("../popup/popup.js", import.meta.url),
    "utf8",
);

const POPUP_ELEMENT_SELECTORS = [
    "#routing-mode",
    "#extension-toggle",
    "#extension-status",
    "#extension-state-label",
    "#ad-auto-skip",
    "#time-saved",
    "#sponsors-skipped",
    "#routing-description",
    "#start-trim",
    "#end-trim",
    "#apply-timing",
    "#llm-enabled",
    "#llm-endpoint",
    "#llm-api-key",
    "#load-llm-models",
    "#llm-model",
    "#scan-channel-description",
    "#toggle-channel-scan",
    "#status",
];

class FakeElement {
    constructor() {
        this.children = [];
        this.listeners = new Map();
        this.value = "";
        this.textContent = "";
        this.disabled = false;
        this.checked = false;
        this.dataset = {};
        this.style = {};
        this.attributes = new Map();
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    appendChild(child) {
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        this.children = [...children];
    }

    async emit(type) {
        for (const listener of this.listeners.get(type) ?? []) {
            await listener({type, target: this});
        }
    }
}

function createHarness(
    storedSettings,
    {
        models = ["provider-large", "provider-small"],
        permissionGranted = true,
        permissionError = null,
    } = {},
) {
    const elements = new Map(POPUP_ELEMENT_SELECTORS.map(selector => [
        selector,
        new FakeElement(),
    ]));
    const savedSettings = [];
    const tabMessages = [];
    const permissionRequests = [];
    const callOrder = [];
    const tabActivationListeners = [];
    let activeTab = {id: 77, url: "https://www.youtube.com/watch?v=test"};

    const context = vm.createContext({
        chrome: {
            permissions: {
                async request(request) {
                    callOrder.push("permissions.request");
                    permissionRequests.push(request);
                    if (permissionError) throw permissionError;
                    return permissionGranted;
                },
            },
            runtime: {
                async sendMessage(message) {
                    if (message.action === "LIST_LLM_MODELS") {
                        return {ok: true, models};
                    }
                    return undefined;
                },
            },
            storage: {
                local: {
                    async get(defaults) {
                        return {...defaults, ...storedSettings};
                    },
                    async set(settings) {
                        callOrder.push("storage.set");
                        savedSettings.push(structuredClone(settings));
                    },
                },
            },
            tabs: {
                async query() {
                    return [structuredClone(activeTab)];
                },
                async sendMessage(tabId, message) {
                    tabMessages.push({
                        tabId,
                        message: structuredClone(message),
                    });
                    if (message.action === "GET_CURRENT_CHANNEL") {
                        return {channelHandle: "@example"};
                    }
                    return undefined;
                },
                onActivated: {
                    addListener(listener) {
                        tabActivationListeners.push(listener);
                    },
                },
                onRemoved: {
                    addListener() {
                    },
                },
            },
            onChanged: {
                addListener() {
                },
            },
        },
        console,
        document: {
            createElement() {
                return new FakeElement();
            },
            querySelector(selector) {
                return elements.get(selector) ?? null;
            },
        },
        Number,
        URL,
        window: {
            close() {
            },
        },
    });
    vm.runInContext(popupSource, context, {filename: "popup.js"});

    return {
        elements,
        callOrder,
        permissionRequests,
        savedSettings,
        tabMessages,
        activateTab(tab) {
            activeTab = structuredClone(tab);
            for (const listener of tabActivationListeners) {
                listener({tabId: tab.id, windowId: 1});
            }
        },
        async flush() {
            await new Promise(resolve => setTimeout(resolve, 0));
        },
    };
}

test("keeps tab-specific messages bound to the tab that opened it", async () => {
    const harness = createHarness({routingMode: "local-fallback"});
    await harness.flush();

    harness.activateTab({id: 88, url: "https://www.youtube.com/watch?v=other"});
    const slider = harness.elements.get("#routing-mode");
    slider.value = "2";
    await slider.emit("change");

    assert.equal(harness.tabMessages.at(-1).tabId, 77);
});

test("provides the controls and detection modes used by popup behavior", () => {
    const popupIds = new Set(
        [...popupHtml.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]),
    );
    for (const selector of POPUP_ELEMENT_SELECTORS) {
        assert.equal(
            popupIds.has(selector.slice(1)),
            true,
            `${selector} is required by popup.js`,
        );
    }
    assert.match(
        popupHtml,
        /Local only[\s\S]*Local fallback[\s\S]*SponsorBlock/,
    );
});

test("defaults the global extension switch on and persists both states", async () => {
    const harness = createHarness({});
    await harness.flush();

    const toggle = harness.elements.get("#extension-toggle");
    assert.equal(toggle.checked, true);
    assert.equal(
        harness.elements.get("#extension-state-label").textContent,
        "Extension on",
    );

    toggle.checked = false;
    await toggle.emit("change");
    assert.deepEqual(harness.savedSettings.at(-1), {toggleExtension: false});
    assert.equal(
        harness.elements.get("#extension-state-label").textContent,
        "Extension off",
    );
    assert.equal(
        harness.tabMessages.at(-1).message.action,
        "EXTENSION_STATE_CHANGED",
    );

    toggle.checked = true;
    await toggle.emit("change");
    assert.deepEqual(harness.savedSettings.at(-1), {toggleExtension: true});
    assert.equal(
        harness.elements.get("#extension-state-label").textContent,
        "Extension on",
    );
});

test("defaults YouTube ad auto-skip on and persists both states", async () => {
    const harness = createHarness({});
    await harness.flush();

    const toggle = harness.elements.get("#ad-auto-skip");
    assert.equal(toggle.checked, true);

    toggle.checked = false;
    await toggle.emit("change");
    assert.deepEqual(harness.savedSettings.at(-1), {
        adAutoSkipEnabled: false,
    });
    assert.equal(
        harness.elements.get("#status").textContent,
        "YouTube ad auto-skip disabled.",
    );

    toggle.checked = true;
    await toggle.emit("change");
    assert.deepEqual(harness.savedSettings.at(-1), {
        adAutoSkipEnabled: true,
    });
    assert.equal(
        harness.elements.get("#status").textContent,
        "YouTube ad auto-skip enabled.",
    );
});

test("migrates the old local-only toggle and saves SponsorBlock-only mode", async () => {
    const harness = createHarness({localOnly: true, routingMode: null});
    await harness.flush();

    const slider = harness.elements.get("#routing-mode");
    assert.equal(slider.value, "0");

    slider.value = "2";
    await slider.emit("input");
    await slider.emit("change");

    assert.equal(
        harness.savedSettings.at(-1).routingMode,
        "sponsorblock-only",
    );
    assert.equal(harness.savedSettings.at(-1).localOnly, false);
    assert.equal(harness.tabMessages.at(-1).tabId, 77);
    assert.equal(
        harness.tabMessages.at(-1).message.action,
        "ROUTING_MODE_CHANGED",
    );
});

test("can always switch the LLM off even with an invalid endpoint", async () => {
    const harness = createHarness({
        llmFallbackEnabled: true,
        llmEndpoint: "not a URL",
        llmModel: "provider-small",
    });
    await harness.flush();

    harness.elements.get("#llm-enabled").checked = false;
    await harness.elements.get("#llm-enabled").emit("change");

    assert.equal(
        harness.savedSettings.at(-1).llmFallbackEnabled,
        false,
    );
    assert.equal(
        harness.elements.get("#status").textContent,
        "LLM verification & fallback disabled.",
    );
});

test("loads dynamic models and autosaves the selection and switches", async () => {
    const harness = createHarness({
        llmFallbackEnabled: false,
        llmEndpoint: "https://ai.hackclub.com",
    });
    await harness.flush();

    await harness.elements.get("#load-llm-models").emit("click");
    assert.deepEqual(
        harness.callOrder.slice(0, 2),
        ["permissions.request", "storage.set"],
        "permission must be requested before the click's user gesture expires",
    );
    const model = harness.elements.get("#llm-model");
    assert.deepEqual(
        model.children.slice(1).map(option => option.value),
        ["provider-large", "provider-small"],
    );
    assert.equal(
        harness.permissionRequests.at(-1).origins[0],
        "https://ai.hackclub.com/*",
    );
    model.value = "provider-small";
    await model.emit("change");
    assert.equal(harness.savedSettings.at(-1).llmModel, "provider-small");

    harness.elements.get("#llm-enabled").checked = true;
    await harness.elements.get("#llm-enabled").emit("change");

    assert.equal(
        harness.savedSettings.at(-1).llmFallbackEnabled,
        true,
    );
    assert.equal(harness.savedSettings.at(-1).llmModel, "provider-small");
    assert.equal(
        harness.tabMessages.at(-1).message.action,
        "ROUTING_MODE_CHANGED",
    );
});

test("does not enable the LLM when endpoint permission is denied", async () => {
    const harness = createHarness({
        llmFallbackEnabled: false,
        llmEndpoint: "https://provider.example/v1",
        llmModel: "provider-small",
    }, {permissionGranted: false});
    await harness.flush();

    harness.elements.get("#llm-enabled").checked = true;
    await harness.elements.get("#llm-enabled").emit("change");

    assert.equal(
        harness.savedSettings.some(settings =>
            settings.llmFallbackEnabled === true),
        false,
    );
    assert.equal(harness.savedSettings.at(-1).llmFallbackEnabled, false);
    assert.equal(harness.elements.get("#llm-enabled").checked, false);
    assert.match(
        harness.elements.get("#status").textContent,
        /permission.*denied/i,
    );
});

test("explains that a not-declared permission error needs an extension reload", async () => {
    const harness = createHarness({
        llmFallbackEnabled: false,
        llmEndpoint: "https://ai.hackclub.com",
        llmModel: "provider-small",
    }, {
        permissionError: new Error(
            "Cannot request origin permission for "
            + "https://ai.hackclub.com/* since it was not declared in the manifest.",
        ),
    });
    await harness.flush();

    harness.elements.get("#llm-enabled").checked = true;
    await harness.elements.get("#llm-enabled").emit("change");

    assert.equal(harness.elements.get("#llm-enabled").checked, false);
    assert.match(
        harness.elements.get("#status").textContent,
        /reload notsponsored.*extensions page/i,
    );
});

test("stops and resumes scanning for the current channel", async () => {
    const harness = createHarness({
        blockedChannelHandles: [],
    });
    await harness.flush();

    const button = harness.elements.get("#toggle-channel-scan");
    assert.equal(button.disabled, false);
    assert.equal(button.textContent, "Stop scanning this channel");
    assert.equal(button.dataset.scanState, "active");

    await button.emit("click");
    assert.deepEqual(harness.savedSettings.at(-1), {
        blockedChannelHandles: ["@example"],
    });
    assert.equal(button.textContent, "Resume scanning this channel");
    assert.equal(button.dataset.scanState, "paused");
    assert.equal(
        harness.elements.get("#status").textContent,
        "Scanning stopped for @example.",
    );
    assert.equal(
        harness.tabMessages.at(-1).message.action,
        "ROUTING_MODE_CHANGED",
    );

    await button.emit("click");
    assert.deepEqual(harness.savedSettings.at(-1), {
        blockedChannelHandles: [],
    });
    assert.equal(button.textContent, "Stop scanning this channel");
    assert.equal(button.dataset.scanState, "active");
    assert.equal(
        harness.elements.get("#status").textContent,
        "Scanning resumed for @example.",
    );
});
