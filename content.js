let currentVideoId = null;
let detectedSponsorSegments = [];
let activeOverlay = null;
let activeSegmentKey = null;
let countdownTimer = null;
let overlayCleanup = null;
let activeKeyboardCancel = null;
let activeSkipCleanup = null;
let activeSkipAdTransition = null;
let activeSkipBubble = null;
let activeAdBubble = null;
let adBubbleTimer = null;
let activeAdResumeCleanup = null;
let activeSkipUndoNotice = null;
let activeSkipUndoSegment = null;
let skipUndoTimer = null;
let suppressSpaceUntilKeyUp = false;
let spaceKeyHeld = false;
let lastObservedVideoTime = null;
let transcriptCaptureEnabled = false;
let extensionEnabled = true;
let adAutoSkipEnabled = true;
let timelineHighlightsLayer = null;
let timelineHighlightSignature = "";
let timelineVideoCleanup = null;
let currentChannelHandle = null;
const cancelledSegments = new Set();
const undoneSponsorRanges = [];
const overlayResumeTimes = new Map();
const skipAttemptedSegments = new Set();

// create the style element for injected HTML
// really annoying to not have CSS tools due to having to set .textContent in a string
const styleEl = document.createElement("style");
styleEl.textContent = `

    /* skip overlay */
    .skip-overlay-container {
      position: absolute;
      right: 24px;
      bottom: 80px;
      z-index: 2147483647;

      width: 280px;
      padding: 16px;

      border: 1px solid #303137;
      border-radius: 14px;
      background: #191a1d;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);

      color: #f2f2f3;
      font-family:
        Inter,
        ui-sans-serif,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      pointer-events: auto;
      transform-origin: bottom right;
      animation: notsponsored-skip-overlay-in 180ms ease-out;
    }

    @keyframes notsponsored-skip-overlay-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }

    .skip-header {
      margin-bottom: 14px;
    }

    .skip-title {
      margin: 0;
      color: #f2f2f3;
      font-size: 14px;
      font-weight: 650;
      letter-spacing: -0.015em;
    }

    .skip-subtitle {
      margin: 5px 0 0;
      color: #a7a8ad;
      font-size: 11px;
      line-height: 1.5;
    }

    .skip-source {
      margin: 10px 0 0;
      color: #7d7e84;
      font-size: 9px;
      line-height: 1.4;
      text-align: right;
    }

    .skip-btn-row {
      display: flex;
      gap: 8px;
      margin-top: 14px;
    }

    .skip-btn {
      flex: 1;
      min-height: 34px;
      padding: 8px 12px;

      border: 1px solid transparent;
      border-radius: 7px;

      font: inherit;
      font-size: 11px;
      font-weight: 650;

      cursor: pointer;
      transition:
        background-color 120ms ease,
        border-color 120ms ease,
        transform 80ms ease,
        opacity 120ms ease;
    }

    .skip-btn:focus-visible {
      outline: 2px solid rgba(229, 72, 63, 0.7);
      outline-offset: 2px;
    }

    .skip-btn:active {
      transform: translateY(1px);
    }

    .skip-btn-now {
      background: #e5483f;
      color: #ffffff;
    }

    .skip-btn-now:hover {
      background: #f05249;
    }

    .skip-btn-cancel {
      border-color: #303137;
      background: #202125;
      color: #d8d8dc;
    }

    .skip-btn-cancel:hover {
      border-color: #414249;
      background: #27282d;
    }

    .skip-btn:disabled {
      cursor: not-allowed;
      opacity: 0.45;
    }

    /* timeline markers */

    .notsponsored-timeline-highlights {
      position: absolute;
      inset: 0;
      z-index: 32;
      overflow: hidden;
      pointer-events: none;
    }

    .notsponsored-timeline-highlight {
      position: absolute;
      top: 1px;
      bottom: 1px;

      min-width: 2px;
      border-radius: 1px;

      background: #d68b1f;
      box-shadow: 0 0 3px rgba(214, 139, 31, 0.55);
      opacity: 0.9;
    }

    .notsponsored-timeline-highlight.source-sponsorblock {
      background: #e5483f;
      box-shadow: 0 0 3px rgba(229, 72, 63, 0.55);
    }
    /* skip bubble (well its more an oval but still) */
    .skip-bubble {
      position: absolute;
      top: clamp(14px, 5%, 36px);
      left: 50%;
      z-index: 2147483647;

      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 16px;

      border-radius: 10px;
      border: 1px solid #1A1A1A;
      background: rgba(20, 20, 20, 0.82);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(6px);

      color: #fff;
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;

      pointer-events: none;
      transform: translateX(-50%);
      animation: notsponsored-skip-bubble-in 160ms ease-out both;
      overflow: hidden;
      --skip-progress: 0;
    }

    .skip-bubble::before {
      color: #fff;
      font-size: 17px;
      font-weight: 700;
      letter-spacing: -4px;
      transform: translateX(-2px);
    }

    .skip-bubble::after {
      content: "";
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: 3px;
      background: #ff4e45;
      transform: scaleX(var(--skip-progress));
      transform-origin: left;
      will-change: transform;
    }

    .skip-bubble.skip-bubble-exit {
      animation: notsponsored-skip-bubble-out 180ms ease-in both;
    }

    .skip-bubble.skip-undo-bubble {
      gap: 12px;
      padding: 0 8px 0 14px;
      pointer-events: auto;
    }

    .skip-bubble.skip-undo-bubble::before,
    .skip-bubble.skip-undo-bubble::after {
      display: none;
    }

    .skip-undo-label {
      line-height: 34px;
    }

    .skip-undo-button {
      min-height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: #ff4e45;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    .skip-undo-button:hover {
      background: rgba(255, 78, 69, 0.14);
    }

    .skip-undo-button:focus-visible {
      outline: 2px solid #ff4e45;
      outline-offset: 1px;
    }

    @keyframes notsponsored-skip-bubble-in {
      from {
        opacity: 0;
        transform: translateX(-50%) scale(0.92);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
    }

    @keyframes notsponsored-skip-bubble-out {
      from {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translateX(-50%) scale(0.96);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .skip-overlay-container,
      .skip-bubble {
        animation: none;
      }

      .skip-bubble.skip-bubble-exit {
        opacity: 0;
      }
    }
    /* ad skipped bubble */
    .ad-bubble {
      position: absolute;
      top: clamp(14px, 5%, 36px);
      left: 50%;
      z-index: 2147483647;

      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 0 16px;

      border-radius: 10px;
      border: 1px solid #1A1A1A;
      background: rgba(20, 20, 20, 0.82);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.28);
      backdrop-filter: blur(6px);

      color: #fff;
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
      white-space: nowrap;

      pointer-events: none;
      transform: translateX(-50%);
      animation: notsponsored-ad-bubble-in 160ms ease-out both;
      overflow: hidden;
      --skip-progress: 0;
    }

    .ad-bubble::before {
      color: #fff;
      font-size: 17px;
      font-weight: 700;
      line-height: 1;
    }

    .ad-bubble::after {
      display: none;
    }

    .ad-bubble.ad-bubble-exit {
      animation: notsponsored-ad-bubble-out 180ms ease-in both;
    }


    @keyframes notsponsored-ad-bubble-in {
      from {
        opacity: 0;
        transform: translateX(-50%) scale(0.92);
      }
      to {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
    }

    @keyframes notsponsored-ad-bubble-out {
      from {
        opacity: 1;
        transform: translateX(-50%) scale(1);
      }
      to {
        opacity: 0;
        transform: translateX(-50%) scale(0.96);
      }
    }

    @media (prefers-reduced-motion: reduce) {
      .ad-bubble {
        animation: none;
      }

      .ad-bubble.ad-bubble-exit {
        opacity: 0;
      }
    }

`;
(document.head || document.documentElement).appendChild(styleEl);

// get the current video id
function getVideoId() {
    try {
        if (location.pathname === "/watch") return new URL(location.href).searchParams.get("v");
        const pathMatch = location.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
        return pathMatch?.[1] ?? null;
    } catch {
        return null;
    }
}

// get the channel handle of the current video
function getChannel() {
    try {
        const channelLink = document.querySelector("ytd-channel-name a, ytd-video-owner-renderer a");
        if (!channelLink) return null;

        const url = new URL(channelLink.href, window.location.origin);
        const pathParts = url.pathname.split("/").filter(Boolean);

        if (pathParts.length === 0) return null;

        // match new @handle ones
        if (pathParts[0].startsWith("@")) {
            return pathParts[0];
        }

        // match old channel handle
        if (pathParts[0] === "c" || pathParts[0] === "channel") {
            return pathParts[1] ?? null;
        }

        return null;
    } catch {
        return null;
    }
}


// normalize the channel handle passed
function normalizedChannelHandle(value) {
    const handle = String(value || "").trim();
    if (!handle) return null;
    return handle.startsWith("@") ? handle.toLowerCase() : `@${handle.toLowerCase()}`;
}


// key for segments
function segmentKey(segment) {
    return `${Math.round(segment.startSec * 10)}:${Math.round(segment.endSec * 10)}`;
}

// check if two segments overlap by at least 0.25 seconds
function segmentsOverlap(left, right) {
    const startSec = Math.max(Number(left?.startSec), Number(right?.startSec));
    const endSec = Math.min(Number(left?.endSec), Number(right?.endSec));
    return Number.isFinite(startSec) && Number.isFinite(endSec) && endSec - startSec > 0.25;
}

// check if a segment is suppressed (canceled, undone, or skipped)
function isSegmentSuppressed(segment) {
    return cancelledSegments.has(segmentKey(segment)) || undoneSponsorRanges.some(range => segmentsOverlap(range, segment)) || (activeSkipUndoSegment !== null && segmentsOverlap(activeSkipUndoSegment, segment));
}


// checks if an ad is currently playing
function isAdPlaying() {
    try {
        return Boolean(document.querySelector(".html5-video-player.ad-showing, .html5-video-player.ad-interrupting",));
    } catch {
        return false;
    }
}

// remove the skip overlay
function removeSkipOverlay() {
    if (countdownTimer) {
        clearInterval(countdownTimer);
        countdownTimer = null;
    }

    if (overlayCleanup) overlayCleanup();
    overlayCleanup = null;

    if (activeOverlay) {
        const currentOverlay = activeOverlay;

        currentOverlay.style.transition = 'opacity 0.3s ease';

        requestAnimationFrame(() => {
            currentOverlay.style.opacity = '0';
        });

        setTimeout(() => {
            currentOverlay.remove();
        }, 300);
    }

    activeOverlay = null;
    activeSegmentKey = null;
    activeKeyboardCancel = null;
}

// remove the timeline highlights
function removeTimelineHighlights() {
    timelineVideoCleanup?.();
    timelineVideoCleanup = null;
    timelineHighlightsLayer?.remove();
    timelineHighlightsLayer = null;
    timelineHighlightSignature = "";
}

// clear the current detection state
function clearDetectionState() {
    activeSkipCleanup?.();
    activeSkipCleanup = null;
    activeSkipAdTransition = null;
    finishAdResume();
    removeSkipBubbleNodes(true);
    removeAdBubbleNodes();
    removeSkipUndoNotice();
    detectedSponsorSegments = [];
    cancelledSegments.clear();
    undoneSponsorRanges.length = 0;
    skipAttemptedSegments.clear();
    overlayResumeTimes.clear();
    lastObservedVideoTime = null;
    removeSkipOverlay();
    removeTimelineHighlights();
}

// update the timeline highlight
function updateTimelineHighlightClip(video, duration) {
    if (!timelineHighlightsLayer) return;
    const currentTime = Number(video.currentTime);
    const playedPercent = Number.isFinite(currentTime) ? (Math.min(duration, Math.max(0, currentTime)) / duration) * 100 : 0;
    const clip = `inset(0 0 0 ${playedPercent}%)`;
    timelineHighlightsLayer.style.clipPath = clip;
    timelineHighlightsLayer.style.webkitClipPath = clip;
}

// bind the timeline highlight updates
function bindTimelineHighlightUpdates(video, duration) {
    const update = () => updateTimelineHighlightClip(video, duration);
    for (const eventName of ["timeupdate", "seeking", "seeked"]) {
        video.addEventListener(eventName, update);
    }

    timelineVideoCleanup = () => {
        for (const eventName of ["timeupdate", "seeking", "seeked"]) {
            video.removeEventListener(eventName, update);
        }
    };
}

// function to ensure the timeline highlights are actually there
function ensureTimelineHighlights() {
    if (!extensionEnabled) {
        removeTimelineHighlights();
        return false;
    }
    if (detectedSponsorSegments.length === 0) {
        removeTimelineHighlights();
        return false;
    }

    const video = document.querySelector("video");
    const progressBar = document.querySelector(".ytp-progress-bar");
    const duration = Number(video?.duration);
    if (!video || !progressBar || !Number.isFinite(duration) || duration <= 0) {
        return false;
    }

    const signature = [currentVideoId, duration.toFixed(3), ...detectedSponsorSegments.map(segment => `${segmentKey(segment)}:${segment.source}`),].join("|");
    if (timelineHighlightsLayer && timelineHighlightsLayer.isConnected && timelineHighlightsLayer.parentElement === progressBar && timelineHighlightSignature === signature) {
        updateTimelineHighlightClip(video, duration);
        return true;
    }


    removeTimelineHighlights();
    const layer = document.createElement("div");
    layer.className = "notsponsored-timeline-highlights";
    layer.ariaHidden = "true";

    for (const segment of detectedSponsorSegments) {
        const startSec = Math.min(duration, Math.max(0, segment.startSec));
        const endSec = Math.min(duration, Math.max(startSec, segment.endSec));
        if (endSec <= startSec) continue;

        const marker = document.createElement("div");
        marker.className = ["notsponsored-timeline-highlight", segment.source === "sponsorblock" ? "source-sponsorblock" : "source-local",].join(" ");
        marker.style.left = `${(startSec / duration) * 100}%`;
        marker.style.width = `${((endSec - startSec) / duration) * 100}%`;
        layer.appendChild(marker);
    }

    if (layer.children.length === 0) return false;
    progressBar.appendChild(layer);
    timelineHighlightsLayer = layer;
    timelineHighlightSignature = signature;
    bindTimelineHighlightUpdates(video, duration);
    updateTimelineHighlightClip(video, duration);
    return true;
}

// check whether a keyboard event represents the space key
function isSpaceKey(event) {
    return event.code === "Space" || event.key === " ";
}

// intercept the space bar to prevent it from pausing the video
function interceptOverlaySpace(event) {
    if (!isSpaceKey(event)) return;

    const pressStartedNow = event.type === "keydown" && !spaceKeyHeld;
    if (event.type === "keydown") spaceKeyHeld = true;
    if (event.type === "keyup") spaceKeyHeld = false;

    if (pressStartedNow && activeOverlay) {
        suppressSpaceUntilKeyUp = true;
        event.preventDefault();
        event.stopImmediatePropagation();
        activeKeyboardCancel?.(event);
        return;
    }

    if (!suppressSpaceUntilKeyUp) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "keyup") suppressSpaceUntilKeyUp = false;
}

// reset the overlay space state if the window looses focus
function resetOverlaySpaceState() {
    spaceKeyHeld = false;
    suppressSpaceUntilKeyUp = false;
}

// add event listeners
window.addEventListener("keydown", interceptOverlaySpace, true);
window.addEventListener("keypress", interceptOverlaySpace, true);
window.addEventListener("keyup", interceptOverlaySpace, true);
window.addEventListener("blur", resetOverlaySpaceState, true);


// return the saved routing mode
function routingModeFromSettings(settings) {
    if (["local-only", "local-fallback", "sponsorblock-only",].includes(settings.routingMode)) {
        return settings.routingMode;
    }
    return settings.localOnly === true ? "local-only" : "local-fallback";
}


// chrome returns a promise here, while some compatible implementations and
// test doubles return undefined. Normalize both shapes and synchronous throws.
function sendRuntimeMessage(message) {
    try {
        return Promise.resolve(chrome.runtime.sendMessage(message));
    } catch (error) {
        return Promise.reject(error);
    }
}

// refresh the transcript method of capture
async function refreshTranscriptCaptureMode() {
    try {
        const settings = await chrome.storage.local.get({
            toggleExtension: true,
            adAutoSkipEnabled: true,
            routingMode: null,
            localOnly: false,
            llmFallbackEnabled: false,
        });
        extensionEnabled = settings.toggleExtension !== false;
        adAutoSkipEnabled = settings.adAutoSkipEnabled !== false;
        transcriptCaptureEnabled = extensionEnabled && (routingModeFromSettings(settings) !== "sponsorblock-only" || settings.llmFallbackEnabled === true);
    } catch (error) {
        extensionEnabled = true;
        transcriptCaptureEnabled = true;
        console.warn("Could not read routing mode; enabling local transcript fallback", error);
    }

    if (!extensionEnabled) clearDetectionState();

    window.postMessage({
        type: "SET_YT_TRANSCRIPT_CAPTURE", enabled: transcriptCaptureEnabled,
    }, "*");
    if (transcriptCaptureEnabled && currentVideoId) {
        window.postMessage({
            type: "REQUEST_YT_TRANSCRIPT", videoId: currentVideoId,
        }, "*");
    }
}

// sync the video state with the current page
function syncVideo() {
    if (!extensionEnabled) return;
    const videoId = getVideoId();
    const channelHandle = normalizedChannelHandle(getChannel());
    if (!videoId) return;
    if (videoId === currentVideoId && channelHandle === currentChannelHandle) return;

    const videoChanged = videoId !== currentVideoId;
    currentChannelHandle = channelHandle;
    if (!videoChanged) {
        void sendRuntimeMessage({
            action: "CHANNEL_CHANGED", videoId, channelHandle,
        }).catch(error => console.error(`Could not report channel for ${videoId}`, error));
        return;
    }

    currentVideoId = videoId;
    clearDetectionState();

    void sendRuntimeMessage({
        action: "VIDEO_CHANGED", videoId, channelHandle,
    })
        .catch(error => console.error(`Could not report video change for ${videoId}`, error));
    if (transcriptCaptureEnabled) {
        window.postMessage({type: "REQUEST_YT_TRANSCRIPT", videoId}, "*");
    }

    console.log(`notsponsored initialized for ${videoId}`);
}

// add motion blur for the skip animations
// it looks really nice!
function addMotionBlur() {
    if (document.getElementById("video-motion-blur-filter")) return;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

    svg.id = "video-motion-blur-filter";
    svg.setAttribute("width", "0");
    svg.setAttribute("height", "0");
    svg.style.position = "absolute";

    svg.innerHTML = `
        <filter
            id="video-motion-blur"
            x="-20%"
            y="-20%"
            width="140%"
            height="140%"
            color-interpolation-filters="sRGB"
        >
            <feGaussianBlur
                stdDeviation="10 1"
                edgeMode="duplicate"
            />
        </filter>
    `;

    document.documentElement.appendChild(svg);
}

// jump the YouTube video to the end of the sponsor segment
// also record the skip stats
function executeVideoSkip(segment, videoElement) {
    if (!extensionEnabled || !segment || !videoElement) return;
    if (activeSkipCleanup || isSegmentSuppressed(segment)) return;

    const key = segmentKey(segment);
    if (skipAttemptedSegments.has(key)) return;

    skipAttemptedSegments.add(key);
    removeSkipOverlay();
    removeSkipUndoNotice();

    const observedSpeed = Number(videoElement.playbackRate);
    const originalSpeed = Number.isFinite(observedSpeed) && observedSpeed > 0 && observedSpeed !== 16 ? observedSpeed : 1;

    let animationFrameId = null;
    let finished = false;

    videoElement.playbackRate = 16;

    console.log(`Skipping video to ${segment.endSec.toFixed(2)}s`);
    // playback speed animation and blur!
    addMotionBlur();

    videoElement.style.filter = "url(#video-motion-blur)";
    videoElement.style.willChange = "filter";
    let skipBubble = showSkipBubble(videoElement);
    let interruptedByAd = false;
    let lastContentTime = Number(videoElement.currentTime);

    function restorePlayback(completed = false) {
        if (finished) return;
        finished = true;
        if (activeSkipCleanup === restorePlayback) {
            activeSkipCleanup = null;
        }
        if (activeSkipAdTransition === setAdInterrupted) {
            activeSkipAdTransition = null;
        }

        if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
        }
        videoElement.style.filter = "";
        videoElement.style.willChange = "";
        videoElement.removeEventListener("seeking", handleSeeking);
        videoElement.removeEventListener("timeupdate", checkProgress);
        removeSkipBubble(skipBubble, completed);

        videoElement.playbackRate = originalSpeed;
        if (completed) showSkipUndoNotice(segment, videoElement);
    }

    function setAdInterrupted(interrupted) {
        if (finished || interrupted === interruptedByAd) return;
        interruptedByAd = interrupted;

        if (interrupted) {
            videoElement.playbackRate = originalSpeed;
            videoElement.style.filter = "";
            videoElement.style.willChange = "";
            removeSkipBubble(skipBubble, true);
            skipBubble = null;
            return;
        }

        // YouTube reuses the video element for the ad timeline, whose time can
        // coincidentally fall inside the sponsor range.
        videoElement.currentTime = lastContentTime;
        videoElement.playbackRate = 16;
        videoElement.style.filter = "url(#video-motion-blur)";
        videoElement.style.willChange = "filter";
        skipBubble = showSkipBubble(videoElement);
    }

    function handleSeeking() {
        if (isAdPlaying()) {
            setAdInterrupted(true);
            return;
        }
        if (interruptedByAd) return;

        const currentTime = videoElement.currentTime;

        if (currentTime < segment.startSec || currentTime >= segment.endSec) {
            restorePlayback();
        }
    }

    function checkProgress() {
        if (finished) return;

        if (isAdPlaying()) {
            setAdInterrupted(true);
            animationFrameId = requestAnimationFrame(checkProgress);
            return;
        }
        if (interruptedByAd) setAdInterrupted(false);

        const currentTime = Number(videoElement.currentTime);
        if (currentTime >= segment.startSec && currentTime < segment.endSec) {
            lastContentTime = currentTime;
        }

        const duration = segment.endSec - segment.startSec;
        const progress = duration > 0 ? Math.min(1, Math.max(0, (currentTime - segment.startSec) / duration,)) : 1;

        skipBubble?.style.setProperty("--skip-progress", String(progress));

        if (currentTime >= segment.endSec) {
            restorePlayback(true);
            videoElement.currentTime = segment.endSec;
            return;
        }

        if (currentTime < segment.startSec) {
            restorePlayback();
            return;
        }

        animationFrameId = requestAnimationFrame(checkProgress);
    }

    videoElement.addEventListener("seeking", handleSeeking);
    videoElement.addEventListener("timeupdate", checkProgress);
    activeSkipCleanup = restorePlayback;
    activeSkipAdTransition = setAdInterrupted;

    animationFrameId = requestAnimationFrame(checkProgress);

    void sendRuntimeMessage({
        action: "RECORD_SKIP_STATS", durationSeconds: segment.endSec - segment.startSec,
    }).catch(error => {
        console.error("Could not record skip stats", error);
    });
}

// fit the card to the actual player
// instead of the browser viewport
// so it doesn't look oversized on smaller players
function updateSkipOverlayLayout(playerElement, videoElement) {
    if (!activeOverlay) return;

    const playerRect = playerElement.getBoundingClientRect?.();
    const videoRect = videoElement.getBoundingClientRect?.();
    const width = Number(videoRect?.width) || Number(videoElement.clientWidth) || Number(playerRect?.width) || Number(playerElement.clientWidth) || 960;
    const height = Number(videoRect?.height) || Number(videoElement.clientHeight) || Number(playerRect?.height) || Number(playerElement.clientHeight) || 540;
    const scale = Math.min(1, Math.max(0.58, Math.min(width / 960, height / 540)),);
    const right = Math.min(24, Math.max(8, width * 0.025));
    const bottom = Math.min(80, Math.max(44, height * 0.148));

    activeOverlay.style.transform = `scale(${Number(scale.toFixed(3))})`;
    activeOverlay.style.right = `${Number(right.toFixed(1))}px`;
    activeOverlay.style.bottom = `${Number(bottom.toFixed(1))}px`;
}

function removeSkipBubble(bubble = activeSkipBubble, immediately = false) {
    if (!bubble) return;
    if (activeSkipBubble === bubble) activeSkipBubble = null;

    if (immediately || !bubble.isConnected) {
        bubble.remove();
        return;
    }

    if (bubble.className.includes("skip-bubble-exit")) return;
    bubble.className += " skip-bubble-exit";

    const finishRemoval = () => bubble.remove();
    bubble.addEventListener("animationend", finishRemoval, {once: true});
    setTimeout(finishRemoval, 220);
}

// remove all skip bubble nodes
function removeSkipBubbleNodes(includeUndoNotice = true) {
    const playerElement = document.querySelector(".html5-video-player");
    const playerChildren = Array.from(playerElement?.children ?? []);
    for (const child of playerChildren) {
        const classNames = String(child.className || "").split(/\s+/);
        if (!classNames.includes("skip-bubble")) continue;
        if (!includeUndoNotice && classNames.includes("skip-undo-bubble")) continue;
        child.remove();
    }
    activeSkipBubble = null;
}

// show the skip bubble
function showSkipBubble(videoElement) {
    if (!extensionEnabled) return null;
    const playerElement = document.querySelector(".html5-video-player") || videoElement.parentElement;
    if (!playerElement) return null;

    removeAdBubbleNodes();
    removeSkipBubbleNodes(false);
    activeSkipBubble = document.createElement("div");
    activeSkipBubble.className = "skip-bubble";
    activeSkipBubble.setAttribute("role", "status");
    activeSkipBubble.setAttribute("aria-live", "polite");
    activeSkipBubble.textContent = "Skipping sponsor";
    playerElement.appendChild(activeSkipBubble);
    return activeSkipBubble;
}

// remove the skip undo notice bubble
function removeSkipUndoNotice(immediately = true) {
    if (skipUndoTimer !== null) {
        clearTimeout(skipUndoTimer);
        skipUndoTimer = null;
    }

    const notice = activeSkipUndoNotice;
    activeSkipUndoNotice = null;
    activeSkipUndoSegment = null;
    removeSkipBubble(notice, immediately);
}

// show the skip undo notice bubble
function showSkipUndoNotice(segment, videoElement) {
    if (!extensionEnabled) return null;
    const playerElement = document.querySelector(".html5-video-player") || videoElement.parentElement;
    if (!playerElement) return null;

    removeSkipUndoNotice();
    const notice = document.createElement("div");
    notice.className = "skip-bubble skip-undo-bubble";

    const label = document.createElement("span");
    label.className = "skip-undo-label";
    label.setAttribute("role", "status");
    label.setAttribute("aria-live", "polite");
    label.textContent = "Sponsor skipped";

    const undoButton = document.createElement("button");
    undoButton.className = "skip-undo-button";
    undoButton.setAttribute("type", "button");
    undoButton.setAttribute("aria-label", "Undo sponsor skip and play skipped segment normally");
    undoButton.textContent = "Undo";

    let undone = false;
    undoButton.addEventListener("click", event => {
        if (undone) return;
        undone = true;
        event.stopPropagation();
        const undoneRange = {
            startSec: segment.startSec, endSec: segment.endSec,
        };
        undoneSponsorRanges.push(undoneRange);
        for (const detectedSegment of detectedSponsorSegments) {
            if (!segmentsOverlap(undoneRange, detectedSegment)) continue;
            const detectedKey = segmentKey(detectedSegment);
            cancelledSegments.add(detectedKey);
            skipAttemptedSegments.delete(detectedKey);
            overlayResumeTimes.delete(detectedKey);
        }
        activeSkipCleanup?.();
        activeSkipCleanup = null;
        if (videoElement.playbackRate === 16) videoElement.playbackRate = 1;
        videoElement.style.filter = "";
        videoElement.style.willChange = "";
        removeSkipBubbleNodes(true);
        removeSkipOverlay();
        removeSkipUndoNotice();
        videoElement.currentTime = segment.startSec;
        void sendRuntimeMessage({
            action: "REVERT_SKIP_STATS", durationSeconds: segment.endSec - segment.startSec,
        }).catch(error => {
            console.error("Could not revert skip stats", error);
        });
    });

    notice.appendChild(label);
    notice.appendChild(undoButton);
    playerElement.appendChild(notice);
    activeSkipUndoNotice = notice;
    activeSkipUndoSegment = {
        startSec: segment.startSec, endSec: segment.endSec,
    };
    skipUndoTimer = setTimeout(() => {
        if (activeSkipUndoNotice === notice) removeSkipUndoNotice(false);
    }, 8_000);
    return notice;
}

// show the skip overlay when a sponsor segment is approaching
function showSkipOverlay(segment, videoElement) {
    if (!extensionEnabled) return;
    const key = segmentKey(segment);
    if (activeOverlay && activeSegmentKey === key) return;
    removeSkipOverlay();

    const playerElement = document.querySelector(".html5-video-player") || videoElement.parentElement;
    if (!playerElement) return;

    activeSegmentKey = key;
    activeOverlay = document.createElement("div");
    activeOverlay.className = "skip-overlay-container";
    activeOverlay.innerHTML = `
          <div class="skip-title">${segment.autoSkip ? "Upcoming Sponsor" : "Possible Sponsor"}</div>
          <div class="skip-subtitle">${segment.autoSkip ? "Skipping automatically soon…" : "LLM suggestion"}</div>
          <div class="skip-btn-row">
            <button class="skip-btn skip-btn-now" type="button">Skip Now</button>
            <button class="skip-btn skip-btn-cancel" type="button">${segment.autoSkip ? "Cancel Skip" : "Dismiss"}</button>
          </div>
          <div class="skip-source"></div>
    `;
    activeOverlay.querySelector(".skip-source").textContent = segment.source === "llm-fallback" ? `Source: LLM fallback${segment.model ? ` — ${segment.model}` : ""} (${segment.confidence})` : segment.source === "sponsorblock" ? "Source: SponsorBlock" : segment.source === "local-only" ? `Source: Local only (${segment.confidence})` : `Source: local fallback (${segment.confidence})`;
    updateSkipOverlayLayout(playerElement, videoElement);
    playerElement.appendChild(activeOverlay);

    const cancel = event => {
        event?.stopPropagation();
        cancelledSegments.add(key);
        removeSkipOverlay();
    };
    const onVideoClick = event => cancel(event);
    activeKeyboardCancel = cancel;

    activeOverlay.querySelector(".skip-btn-now").addEventListener("click", event => {
        event.stopPropagation();
        executeVideoSkip(segment, videoElement);
    });
    activeOverlay.querySelector(".skip-btn-cancel").addEventListener("click", cancel);
    videoElement.addEventListener("click", onVideoClick, {once: true});
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => updateSkipOverlayLayout(playerElement, videoElement)) : null;
    resizeObserver?.observe(playerElement);
    if (videoElement !== playerElement) resizeObserver?.observe(videoElement);
    overlayCleanup = () => {
        videoElement.removeEventListener("click", onVideoClick);
        resizeObserver?.disconnect();
    };

    const updateCountdown = () => {
        updateSkipOverlayLayout(playerElement, videoElement);
        const remaining = Math.max(0, segment.startSec - videoElement.currentTime);
        const label = activeOverlay?.querySelector(".skip-subtitle");
        if (label) {
            label.textContent = segment.autoSkip ? `Skipping automatically in ${Math.floor(remaining)}s… (press the space bar or click the video to cancel)` : `Possible sponsor starts in ${Math.floor(remaining)}s. Choose Skip Now or dismiss.`;
        }
    };
    updateCountdown();
    countdownTimer = setInterval(updateCountdown, 100);
}

function showAdBubble(videoElement) {
    if (!extensionEnabled) return null;
    const playerElement = document.querySelector(".html5-video-player") || videoElement.parentElement;
    if (!playerElement) return null;

    removeSkipBubbleNodes(false);
    removeAdBubbleNodes();
    const bubble = document.createElement("div");
    bubble.className = "ad-bubble";
    bubble.setAttribute("role", "status");
    bubble.setAttribute("aria-live", "polite");
    bubble.textContent = "Ad skipped";
    playerElement.appendChild(bubble);
    activeAdBubble = bubble;
    adBubbleTimer = setTimeout(() => {
        if (activeAdBubble === bubble) removeAdBubble(bubble);
    }, 2_000);
    return bubble;
}

function removeAdBubble(bubble = activeAdBubble, immediately = false) {
    if (!bubble) return;
    if (activeAdBubble === bubble) {
        activeAdBubble = null;
        if (adBubbleTimer !== null) {
            clearTimeout(adBubbleTimer);
            adBubbleTimer = null;
        }
    }

    if (immediately || !bubble.isConnected) {
        bubble.remove();
        return;
    }

    if (bubble.className.includes("ad-bubble-exit")) return;
    bubble.className += " ad-bubble-exit";

    const finishRemoval = () => bubble.remove();
    bubble.addEventListener("animationend", finishRemoval, {once: true});
    setTimeout(finishRemoval, 220);
}

function removeAdBubbleNodes() {
    if (adBubbleTimer !== null) {
        clearTimeout(adBubbleTimer);
        adBubbleTimer = null;
    }
    const playerElement = document.querySelector(".html5-video-player");
    for (const child of Array.from(playerElement?.children ?? [])) {
        const classNames = String(child.className || "").split(/\s+/);
        if (classNames.includes("ad-bubble")) child.remove();
    }
    activeAdBubble = null;
}

function finishAdResume() {
    activeAdResumeCleanup?.();
    activeAdResumeCleanup = null;
}

// skip youtube ads by seeking to the end of the ad and resuming their playback
function skipAd(videoElement) {
    if (!extensionEnabled || !videoElement) return false;
    const duration = Number(videoElement.duration);
    const currentTime = Number(videoElement.currentTime);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return false;

    const skipTarget = Math.max(0, duration - 0.05);
    if (currentTime >= skipTarget - 0.01) return false;

    videoElement.currentTime = skipTarget;
    const seekSucceeded = Number(videoElement.currentTime) >= skipTarget - 0.1;
    if (!seekSucceeded) return false;

    if (!activeAdResumeCleanup) {
        const wasPaused = videoElement.paused === true;
        activeAdResumeCleanup = () => {
            if (wasPaused) videoElement.pause?.();
        };
    }
    try {
        void Promise.resolve(videoElement.play?.()).catch(error => {
            console.warn("Could not resume the ad after seeking", error);
        });
    } catch (error) {
        console.warn("Could not resume the ad after seeking", error);
    }

    const skipButton = document.querySelector(".ytp-ad-skip-button, .ytp-ad-overlay-close-button");
    if (skipButton) skipButton.click();
    // the skip button thing doesn't work because
    // chrome sets it as untrusted
    // and youtube ignores untrusted actions
    // so this may or may not work
    // but the auto seek does work

    showAdBubble(videoElement);
    return true;
}

// clear and refresh the detection state
function setState() {
    currentVideoId = null;
    currentChannelHandle = null;
    transcriptCaptureEnabled = false;
    extensionEnabled = false;
    clearDetectionState();
    window.postMessage({
        type: "SET_YT_TRANSCRIPT_CAPTURE", enabled: false,
    }, "*");
    refreshTranscriptCaptureMode()
        .then(() => syncVideo())
        .catch(error => console.error(error));
}

// on message listeners
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.action === "GET_CURRENT_CHANNEL") {
        sendResponse({
            videoId: getVideoId(), channelHandle: normalizedChannelHandle(getChannel()),
        });
        return;
    }
    if (message.action === "ROUTING_MODE_CHANGED" || message.action === "EXTENSION_STATE_CHANGED") {
        setState()
        return;
    }
    if (message.action !== "SET_SPONSOR_SEGMENTS" || message.videoId !== currentVideoId) return;
    if (!extensionEnabled) return;

    detectedSponsorSegments = (message.segments ?? [])
        .map(segment => ({
            startSec: segment.startMs / 1000,
            endSec: segment.endMs / 1000,
            source: segment.source ?? message.source,
            confidence: segment.confidence ?? "unknown",
            autoSkip: segment.autoSkip !== false,
            model: typeof segment.model === "string" ? segment.model : "",
        }))
        .filter(segment => Number.isFinite(segment.startSec) && Number.isFinite(segment.endSec) && segment.endSec > segment.startSec)
        .sort((a, b) => a.startSec - b.startSec);

    const currentSegmentKeys = new Set(detectedSponsorSegments.map(segmentKey));
    for (const key of skipAttemptedSegments) {
        if (!currentSegmentKeys.has(key)) skipAttemptedSegments.delete(key);
    }
    overlayResumeTimes.clear();
    lastObservedVideoTime = null;
    removeSkipOverlay();
    ensureTimelineHighlights();
    console.log(`Registered ${detectedSponsorSegments.length} ${message.source} segment(s)`, detectedSponsorSegments);
});

window.addEventListener("message", event => {
    if (event.source !== window || !event.data) return;

    const payload = event.data.payload;
    if (!payload || payload.videoId !== currentVideoId) return;
    if (!extensionEnabled || !transcriptCaptureEnabled) return;

    if (event.data.type === "YT_TRANSCRIPT_INTERCEPTED" && typeof payload.data === "string") {
        void sendRuntimeMessage({
            action: "PROCESS_TRANSCRIPT", videoId: payload.videoId, data: payload.data,
        }).catch(error => console.error(`Could not process transcript for ${payload.videoId}`, error));
    } else if (event.data.type === "YT_TRANSCRIPT_STATUS" && typeof payload.status === "string") {
        void sendRuntimeMessage({
            action: "TRANSCRIPT_STATUS",
            videoId: payload.videoId,
            status: payload.status,
            reason: typeof payload.reason === "string" ? payload.reason : "",
        }).catch(error => console.error(`Could not report transcript status for ${payload.videoId}`, error));
    }
});

// listener to catch when a video is navigated to, and re-sync the video state
window.addEventListener("yt-navigate-finish", syncVideo);
setInterval(syncVideo, 1_000);
refreshTranscriptCaptureMode()
    .then(() => syncVideo())
    .catch(error => console.error(error));

chrome.storage.onChanged?.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes.adAutoSkipEnabled) {
        adAutoSkipEnabled = changes.adAutoSkipEnabled.newValue !== false;
        if (!adAutoSkipEnabled) finishAdResume();
    }
    if (!changes.toggleExtension) return;
    setState()
});

// interval for the main loop to check for
// ad playback and skipping,
// showing/hiding the skip overlay,
// and removing/drawing the timeline highlights
setInterval(() => {
    if (!extensionEnabled) {
        clearDetectionState();
        return;
    }

    // Keep sponsor UI inactive during ads even when ad auto-skip is disabled.
    if (isAdPlaying()) {
        removeSkipOverlay();
        removeTimelineHighlights();
        activeSkipAdTransition?.(true);
        if (adAutoSkipEnabled) skipAd(document.querySelector("video"));
        return;
    }

    finishAdResume();
    activeSkipAdTransition?.(false);

    if (!activeSkipCleanup) removeSkipBubbleNodes(false);


    // make sure the timeline highlights actually exist
    ensureTimelineHighlights();
    const videoElement = document.querySelector("video");
    if (!videoElement) {
        lastObservedVideoTime = null;
        return;
    }

    // if the video time was shifted backwards more than 15 sec total, remove the skip overlay
    const currentTime = videoElement.currentTime;
    if (lastObservedVideoTime !== null && currentTime < lastObservedVideoTime - 0.5) {
        if (activeSegmentKey) {
            overlayResumeTimes.set(activeSegmentKey, lastObservedVideoTime);
        }
        removeSkipOverlay();
    }
    lastObservedVideoTime = currentTime;
    if (detectedSponsorSegments.length === 0) return;

    // check if the current video time is within any detected sponsor segment
    if (activeSegmentKey) {
        const activeSegment = detectedSponsorSegments.find(segment => segmentKey(segment) === activeSegmentKey);
        if (!activeSegment || currentTime < activeSegment.startSec - 15 || currentTime >= activeSegment.endSec) {
            removeSkipOverlay();
        }
    }

    // if it is, then show the skip overlay
    for (const segment of detectedSponsorSegments) {
        const key = segmentKey(segment);
        const timeUntilSponsor = segment.startSec - currentTime;
        const resumeTime = overlayResumeTimes.get(key);
        const cardSuppressed = resumeTime !== undefined && currentTime < resumeTime - 0.25;
        if (resumeTime !== undefined && !cardSuppressed) {
            overlayResumeTimes.delete(key);
        }

        if (skipAttemptedSegments.has(key) && (currentTime < segment.startSec || currentTime >= segment.endSec)) {
            skipAttemptedSegments.delete(key);
        }

        const segmentSuppressed = isSegmentSuppressed(segment);
        if (timeUntilSponsor > 0 && timeUntilSponsor <= 15 && !segmentSuppressed && !cardSuppressed) {
            showSkipOverlay(segment, videoElement);
        }

        if (currentTime >= segment.startSec && currentTime < segment.endSec) {
            if (!segmentSuppressed && segment.autoSkip) {
                executeVideoSkip(segment, videoElement);
            } else if (!segmentSuppressed && !segment.autoSkip && !activeOverlay) {
                showSkipOverlay(segment, videoElement);
            } else if (segmentSuppressed) {
                removeSkipOverlay();
            }
            break;
        }
        // remove the skip overlay if the current video time is out of segment bounds
        if (currentTime >= segment.endSec && activeSegmentKey === key) removeSkipOverlay();
    }
}, 250);
