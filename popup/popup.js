const timeSaved = document.querySelector("#time-saved");
const sponsorsSkipped = document.querySelector("#sponsors-skipped");
const toggleExtensionButton = document.querySelector("#extension-toggle");
const extensionStatus = document.querySelector("#extension-status");
const extensionStateLabel = document.querySelector("#extension-state-label");
const adAutoSkipInput = document.querySelector("#ad-auto-skip");
const routingModeSlider = document.querySelector("#routing-mode");
const routingDescription = document.querySelector("#routing-description");
const startTrimInput = document.querySelector("#start-trim");
const endTrimInput = document.querySelector("#end-trim");
const applyTimingButton = document.querySelector("#apply-timing");
const llmEnabledInput = document.querySelector("#llm-enabled");
const llmEndpointInput = document.querySelector("#llm-endpoint");
const llmApiKeyInput = document.querySelector("#llm-api-key");
const loadLlmModelsButton = document.querySelector("#load-llm-models");
const llmModelSelect = document.querySelector("#llm-model");
const scanChannelDescription = document.querySelector("#scan-channel-description");
const toggleChannelScanButton = document.querySelector("#toggle-channel-scan");
const scanChannelSection = document.querySelector("#scan-channel");
const status = document.querySelector("#status");
const DEFAULT_LLM_ENDPOINT = "https://api.openai.com/v1";
let popupTab = null;
let currentChannelHandle = null;
let blockedChannelHandles = [];

// render the extension state in the popup
function renderExtensionState(enabled) {
    const isEnabled = enabled !== false;
    toggleExtensionButton.checked = isEnabled;
    extensionStatus.dataset.extensionState = isEnabled ? "on" : "off";
    extensionStateLabel.textContent = isEnabled ? "Extension on" : "Extension off";
}

// the different routing modes
const ROUTING_MODES = [{
    value: "local-only", name: "Local only", description: "Detect sponsor segments locally from the video transcript.",
}, {
    value: "local-fallback",
    name: "Local fallback",
    description: "Try SponsorBlock first, and fallback to local sponsor detection.",
}, {
    value: "sponsorblock-only", name: "SponsorBlock only", description: "Only use SponsorBlock API segments.",
},];

// get the routing mode index from the settings
function modeIndexFromSettings(settings) {
    const storedIndex = ROUTING_MODES.findIndex(mode => mode.value === settings.routingMode);
    if (storedIndex >= 0) return storedIndex;
    return settings.localOnly === true ? 0 : 1;
}

// render which routing mode is being used
function renderRoutingMode(index) {
    const safeIndex = Math.min(2, Math.max(0, Number(index) || 0));
    const mode = ROUTING_MODES[safeIndex];
    routingModeSlider.value = String(safeIndex);
    routingDescription.textContent = mode.description;
    routingModeSlider.setAttribute("aria-valuetext", mode.name);
    return mode;
}

// render the usage stats
function renderStats(usageStats) {
    const seconds = Math.max(0, Number(usageStats?.time ?? usageStats?.timeSaved ?? 0));
    const skipped = Math.max(0, Number(usageStats?.skippedSegments ?? usageStats?.sponsorsSkipped ?? 0));
    const formatDuration = (totalSeconds) => {
        const roundedSeconds = Math.round(totalSeconds);
        const minutes = Math.floor(roundedSeconds / 60);
        const seconds = roundedSeconds % 60;
        if (minutes <= 0) return `${seconds}s`;
        if (seconds === 0) return `${minutes}m`;
        return `${minutes}m ${seconds}s`;
    }
    timeSaved.textContent = formatDuration(seconds);
    sponsorsSkipped.textContent = String(skipped);
}

// normalize channel handles passed
function normalizedChannelHandle(value) {
    const handle = String(value || "").trim();
    if (!handle) return "";
    return handle.startsWith("@") ? handle.toLowerCase() : `@${handle.toLowerCase()}`;
}

// normalize a list of channel handles and remove duplicates
function normalizedBlockedChannelHandles(values) {
    return [...new Set(
        (Array.isArray(values) ? values : [])
            .map(normalizedChannelHandle)
            .filter(Boolean),
    )].sort((left, right) => left.localeCompare(right));
}

// render the channel scan box
function renderChannelScan() {
    if (!currentChannelHandle) {
        scanChannelSection.style.display = "none";
        return;
    }

    const blocked = Boolean(currentChannelHandle)
        && blockedChannelHandles.includes(currentChannelHandle);
    scanChannelDescription.textContent = blocked
        ? `Scanning is off for ${currentChannelHandle}.`
        : `Scanning is on for ${currentChannelHandle}.`;
    toggleChannelScanButton.textContent = blocked
        ? "Resume scanning this channel"
        : "Stop scanning this channel";
    toggleChannelScanButton.dataset.scanState = blocked ? "paused" : "active";
    toggleChannelScanButton.disabled = false;
}

// notify the tab that opened the popup
async function notifyPopupTab(action = "ROUTING_MODE_CHANGED") {
    if (!Number.isInteger(popupTab?.id) || !popupTab.url?.includes("youtube.com/")) return false;

    try {
        await chrome.tabs.sendMessage(popupTab.id, {action});
        return true;
    } catch {
        return false;
    }
}

// load settings and stuff from local storage
async function loadSetting() {
    const settings = await chrome.storage.local.get({
        toggleExtension: true,
        adAutoSkipEnabled: true,
        routingMode: null,
        localOnly: false,
        startTrimSeconds: 3,
        endTrimSeconds: 3,
        llmFallbackEnabled: false,
        llmEndpoint: DEFAULT_LLM_ENDPOINT,
        llmApiKey: "",
        llmModel: "",
        stats: {},
        blockedChannelHandles: [],
    });
    blockedChannelHandles = normalizedBlockedChannelHandles(settings.blockedChannelHandles);
    renderRoutingMode(modeIndexFromSettings(settings));
    startTrimInput.value = String(settings.startTrimSeconds);
    endTrimInput.value = String(settings.endTrimSeconds);
    renderExtensionState(settings.toggleExtension !== false);
    adAutoSkipInput.checked = settings.adAutoSkipEnabled !== false;
    llmEnabledInput.checked = settings.llmFallbackEnabled === true;
    llmEndpointInput.value = String(settings.llmEndpoint || DEFAULT_LLM_ENDPOINT);
    llmApiKeyInput.value = String(settings.llmApiKey || "");
    renderStats(settings.stats);
    const savedModel = String(settings.llmModel || "").trim();
    setModelOptions(savedModel ? [savedModel] : [], savedModel);
    try {
        if (!Number.isInteger(popupTab?.id) || !popupTab.url?.includes("youtube.com/")) return null;
        const response = await chrome.tabs.sendMessage(popupTab.id, {action: "GET_CURRENT_CHANNEL"});
        currentChannelHandle = await normalizedChannelHandle(response?.channelHandle);
    } catch {
        currentChannelHandle = null;
    }
    renderChannelScan();
}

// normalize the endpoint and ensure it is a valid URL
function normalizedEndpoint(value) {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("The endpoint must use HTTP or HTTPS.");
    }
    if (url.username || url.password) {
        throw new Error("Put credentials in the API key field.");
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "");
}

// request permission for contacting the llm endpoint
async function requestEndpointPermission(endpoint) {
    if (!chrome.permissions?.request) return true;
    try {
        const url = new URL(normalizedEndpoint(endpoint));
        return await chrome.permissions.request({
            origins: [`${url.protocol}//${url.hostname}/*`],
        });
    } catch (error) {
        if (/not declared in the manifest/i.test(String(error?.message || error))) {
            throw new Error(
                "Reload notsponsored from the extensions page, then try again.",
            );
        }
        throw error;
    }
}

// set the available model options in the dropdown
function setModelOptions(models, selectedModel = "") {
    const selected = String(selectedModel || "").trim();
    const values = [...new Set(models.map(model => String(model || "").trim()).filter(Boolean),)].sort((left, right) => left.localeCompare(right));
    const selection = values.includes(selected) ? selected : "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = values.length ? "Choose a model" : "Load models from the provider first";
    llmModelSelect.replaceChildren(placeholder);
    for (const model of values) {
        const option = document.createElement("option");
        option.value = model;
        option.textContent = model;
        llmModelSelect.appendChild(option);
    }
    llmModelSelect.disabled = values.length === 0;
    llmModelSelect.value = selection;
}

// function to ensure the input is a valid number between 0 and 60
function trimValue(input) {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return 3;
    return Math.min(60, Math.max(0, value));
}

// save the llm settings and apply them immediately
async function saveLlmPatch(patch = {},) {
    try {
        await chrome.storage.local.set(patch);
        return true;
    } catch (error) {
        status.textContent = `Could not save LLM settings: ${error.message}`;
        return false;
    }
}

// event listener to handle extension toggle
toggleExtensionButton.addEventListener("change", async () => {
    const enabled = toggleExtensionButton.checked;
    const previousEnabled = !enabled;
    toggleExtensionButton.disabled = true;
    try {
        await chrome.storage.local.set({toggleExtension: enabled});
        renderExtensionState(enabled);
        await notifyPopupTab("EXTENSION_STATE_CHANGED");
        status.textContent = enabled
            ? "Extension enabled"
            : "Extension disabled";
    } catch (error) {
        renderExtensionState(previousEnabled);
        status.textContent = `Could not save extension toggle: ${error.message}`;
    } finally {
        toggleExtensionButton.disabled = false;
    }
});

// event listener to handle ad auto-skip toggle
adAutoSkipInput.addEventListener("change", async () => {
    const enabled = adAutoSkipInput.checked;
    adAutoSkipInput.disabled = true;
    try {
        await chrome.storage.local.set({adAutoSkipEnabled: enabled});
        status.textContent = enabled
            ? "YouTube ad auto-skip enabled."
            : "YouTube ad auto-skip disabled.";
    } catch (error) {
        adAutoSkipInput.checked = !enabled;
        status.textContent = `Could not save ad auto-skip: ${error.message}`;
    } finally {
        adAutoSkipInput.disabled = false;
    }
});

// event listener to handle input changes on the routing mode slider
routingModeSlider.addEventListener("input", () => {
    renderRoutingMode(routingModeSlider.value);
});

// event listener to actually make the change immediately and save it to localstorage
routingModeSlider.addEventListener("change", async () => {
    routingModeSlider.disabled = true;
    const mode = renderRoutingMode(routingModeSlider.value);

    try {
        await chrome.storage.local.set({
            routingMode: mode.value, localOnly: mode.value === "local-only",
        });
        await notifyPopupTab();
        status.textContent = `${mode.name} enabled.`;
    } catch (error) {
        await loadSetting();
        status.textContent = `Could not save the setting: ${error.message}`;
    } finally {
        routingModeSlider.disabled = false;
    }
});

// event listener to load the llm models from the endpoint and populate the dropdown
loadLlmModelsButton.addEventListener("click", async () => {
    loadLlmModelsButton.disabled = true;
    try {
        const endpoint = normalizedEndpoint(llmEndpointInput.value);
        const granted = await requestEndpointPermission(endpoint);
        if (!granted) {
            throw new Error("Permission to contact that endpoint was denied.");
        }
        await chrome.storage.local.set({
            llmEndpoint: endpoint, llmApiKey: llmApiKeyInput.value,
        });
        llmEndpointInput.value = endpoint;
        const response = await chrome.runtime.sendMessage({
            action: "LIST_LLM_MODELS", endpoint, apiKey: llmApiKeyInput.value,
        });
        if (!response?.ok) {
            throw new Error(response?.error || "The provider did not return models.");
        }
        setModelOptions(response.models ?? [], llmModelSelect.value);
        await chrome.storage.local.set({
            llmModel: llmModelSelect.value,
        });
        if (llmEnabledInput.checked) await notifyPopupTab();
        status.textContent = response.models?.length ? `Loaded ${response.models.length} model(s).` : "The provider returned no models.";
    } catch (error) {
        // catch thrown errors/messages to display them in the status box
        status.textContent = `Could not load models: ${error.message}`;
    } finally {
        loadLlmModelsButton.disabled = false;
    }
});

// event listener to save the llm endpoint value
llmEndpointInput.addEventListener("input", async () => {
    await saveLlmPatch({
        llmEndpoint: String(llmEndpointInput.value || ""),
    });
});

// event listener to save the llm api key value
llmApiKeyInput.addEventListener("input", async () => {
    await saveLlmPatch({
        llmApiKey: llmApiKeyInput.value,
    });
});

// event listener to save model choice
llmModelSelect.addEventListener("change", async () => {
    await saveLlmPatch({llmModel: String(llmModelSelect.value || "").trim()});
});

// event listener to enable or disable llm verification and fallback
llmEnabledInput.addEventListener("change", async () => {
    llmEnabledInput.disabled = true;
    try {
        const llmFallbackEnabled = llmEnabledInput.checked;
        if (!llmFallbackEnabled) {
            await chrome.storage.local.set({llmFallbackEnabled: false});
            await notifyPopupTab();
            status.textContent = "LLM verification & fallback disabled.";
            return;
        }

        const rawEndpoint = String(llmEndpointInput.value || "").trim();
        const llmEndpoint = normalizedEndpoint(rawEndpoint);
        const llmModel = String(llmModelSelect.value || "").trim();
        if (!llmModel) {
            throw new Error("Load and choose a model first.");
        }
        const granted = await requestEndpointPermission(llmEndpoint);
        if (!granted) {
            throw new Error("Permission to contact that endpoint was denied.");
        }

        await chrome.storage.local.set({
            llmFallbackEnabled: true,
            llmEndpoint,
            llmApiKey: llmApiKeyInput.value,
            llmModel,
        });
        await notifyPopupTab();
        llmEndpointInput.value = llmEndpoint;
        status.textContent = `LLM verification & fallback enabled with ${llmModel}.`;
    } catch (error) {
        llmEnabledInput.checked = false;
        try {
            await chrome.storage.local.set({llmFallbackEnabled: false});
        } catch (storageError) {
            status.textContent = `Could not disable LLM verification: ${storageError.message}`;
            return;
        }
        status.textContent = `Could not enable LLM verification: ${error.message}`;
    } finally {
        llmEnabledInput.disabled = false;
    }
});

// event listener to save the trim timing values and notify the current tab
applyTimingButton.addEventListener("click", async () => {
    const startTrimSeconds = trimValue(startTrimInput);
    const endTrimSeconds = trimValue(endTrimInput);
    startTrimInput.value = String(startTrimSeconds);
    endTrimInput.value = String(endTrimSeconds);
    applyTimingButton.disabled = true;

    try {
        await chrome.storage.local.set({startTrimSeconds, endTrimSeconds});
        await notifyPopupTab();
        status.textContent = `Trim timing saved: start +${startTrimSeconds}s, end -${endTrimSeconds}s.`;
    } catch (error) {
        status.textContent = `Could not save trim timing: ${error.message}`;
    } finally {
        applyTimingButton.disabled = false;
    }
});

// event listener to toggle scanning for the current channel
toggleChannelScanButton.addEventListener("click", async () => {
    if (!currentChannelHandle) return;
    toggleChannelScanButton.disabled = true;
    try {
        const blocked = Boolean(currentChannelHandle)
            && blockedChannelHandles.includes(currentChannelHandle);
        blockedChannelHandles = blocked
            ? blockedChannelHandles.filter(handle => handle !== currentChannelHandle)
            : normalizedBlockedChannelHandles([...blockedChannelHandles, currentChannelHandle]);
        await chrome.storage.local.set({blockedChannelHandles});
        await notifyPopupTab();
        renderChannelScan();
        status.textContent = blocked
            ? `Scanning resumed for ${currentChannelHandle}.`
            : `Scanning stopped for ${currentChannelHandle}.`;
    } catch (error) {
        status.textContent = `Could not update channel scanning: ${error.message}`;
        await loadSetting();
    } finally {
        renderChannelScan();
    }
});

// event listener to handle changes in local storage
chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName === "local" && changes.toggleExtension) {
        renderExtensionState(changes.toggleExtension.newValue !== false);
    }
    if (areaName === "local" && changes.stats) {
        renderStats(changes.stats.newValue);
    }
    if (areaName === "local" && changes.adAutoSkipEnabled) {
        adAutoSkipInput.checked = changes.adAutoSkipEnabled.newValue !== false;
    }
    if (areaName === "local" && changes.blockedChannelHandles) {
        blockedChannelHandles = normalizedBlockedChannelHandles(changes.blockedChannelHandles.newValue);
        renderChannelScan();
    }
});

// event listener to close the popup if the user switches to a different tab
chrome.tabs.onActivated?.addListener(({tabId}) => {
    if (Number.isInteger(popupTab?.id) && tabId !== popupTab.id) {
        window.close();
    }
});

// event listener to close the popup if the user closes the tab that opened it
chrome.tabs.onRemoved?.addListener(tabId => {
    if (tabId === popupTab?.id) window.close();
});

// capture the opening tab before loading any tab-specific popup state.
chrome.tabs.query({active: true, currentWindow: true}).then(([tab]) => {
    popupTab = tab ?? null;
    return loadSetting();
}).catch(error => {
    toggleExtensionButton.disabled = true;
    adAutoSkipInput.disabled = true;
    routingModeSlider.disabled = true;
    startTrimInput.disabled = true;
    endTrimInput.disabled = true;
    llmEnabledInput.disabled = true;
    llmEndpointInput.disabled = true;
    llmApiKeyInput.disabled = true;
    loadLlmModelsButton.disabled = true;
    llmModelSelect.disabled = true;
    toggleChannelScanButton.disabled = true;
    applyTimingButton.disabled = true;
    status.textContent = `Could not load the setting: ${error.message}`;
});
