(() => {
    // store the original window.fetch
    const originalFetch = window.fetch.bind(window);
    const transcriptsByVideo = new Map();
    const inFlightVideos = new Set();
    const lastStatusByVideo = new Map();
    let captureEnabled = false;

    // get the video id of the current video
    function currentVideoId() {
        try {
            if (location.pathname === "/watch") return new URL(location.href).searchParams.get("v");
            const pathMatch = location.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/);
            return pathMatch?.[1] ?? null;
        } catch {
            return null;
        }
    }

    // check if an ad is currently playing
    function isAdPlaying() {
        return Boolean(document.querySelector(
            ".html5-video-player.ad-showing, .html5-video-player.ad-interrupting",
        ));
    }

    // post the intercepted transcript
    function postTranscript(videoId, body) {
        window.postMessage({
            type: "YT_TRANSCRIPT_INTERCEPTED",
            payload: {videoId, data: body},
        }, "*");
    }

    // post the status of the transcript capture
    function postStatus(videoId, status, reason = "") {
        if (!captureEnabled || !videoId || transcriptsByVideo.has(videoId)) return;

        const statusKey = `${status}:${reason}`;
        if (lastStatusByVideo.get(videoId) === statusKey) return;
        lastStatusByVideo.set(videoId, statusKey);
        window.postMessage({
            type: "YT_TRANSCRIPT_STATUS",
            payload: {videoId, status, reason},
        }, "*");
    }

    // deliver the intercepted transcript
    function deliverTranscript(videoId, body, reportInvalid = true) {
        if (!captureEnabled || !videoId || typeof body !== "string") return false;
        if (transcriptsByVideo.get(videoId) === body) return false;

        try {
            const parsed = JSON.parse(body);
            if (!Array.isArray(parsed.events) || parsed.events.length === 0) {
                if (reportInvalid) {
                    postStatus(videoId, "unavailable", "caption response contained no transcript events");
                }
                return false;
            }
        } catch {
            if (reportInvalid) {
                postStatus(videoId, "fetch-error", "caption response was not valid JSON");
            }
            return false;
        }

        transcriptsByVideo.set(videoId, body);
        lastStatusByVideo.delete(videoId);
        postTranscript(videoId, body);
        return true;
    }


    // hopefully choose the english track from the list of available tracks
    function chooseCaptionTrack(captionTracks) {
        if (!Array.isArray(captionTracks) || captionTracks.length === 0) return null;
        return captionTracks.find(track => track.languageCode === "en" && track.kind !== "asr")
            ?? captionTracks.find(track => track.languageCode === "en")
            ?? captionTracks.find(track => track.languageCode?.startsWith("en"))
            ?? captionTracks.find(track => track.kind !== "asr")
            ?? captionTracks[0];
    }

    // inspect the response from the player
    async function inspectPlayerResponse(playerResponse) {
        if (!captureEnabled) return;
        const videoId = playerResponse?.videoDetails?.videoId;
        if (!videoId) return;

        if (transcriptsByVideo.has(videoId)) return;
        if (inFlightVideos.has(videoId)) return;

        const tracks = playerResponse?.captions
            ?.playerCaptionsTracklistRenderer
            ?.captionTracks;
        const track = chooseCaptionTrack(tracks);
        if (!track?.baseUrl) {
            postStatus(videoId, "unavailable", "YouTube player response has no caption track");
            return;
        }

        inFlightVideos.add(videoId);
        try {
            const transcriptUrl = new URL(String(track.baseUrl), location.origin);
            transcriptUrl.searchParams.set("fmt", "json3");
            const response = await originalFetch(transcriptUrl.toString(), {credentials: "include"});
            if (!response.ok) {
                postStatus(videoId, "fetch-error", `caption endpoint returned HTTP ${response.status}`);
                return;
            }
            deliverTranscript(videoId, await response.text());
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            postStatus(videoId, "fetch-error", reason);
            console.debug("notsponsored could not fetch the caption track", error);
        } finally {
            inFlightVideos.delete(videoId);
        }
    }

    // inspect the window player response
    function inspectWindowPlayerResponse(expectedVideoId, attemptsLeft = 40) {
        if (!captureEnabled) return;
        if (typeof expectedVideoId !== "string" || expectedVideoId.length === 0) return;

        const cachedTranscript = transcriptsByVideo.get(expectedVideoId);
        if (cachedTranscript) {
            postTranscript(expectedVideoId, cachedTranscript);
            return;
        }

        const response = window.ytInitialPlayerResponse;
        if (response?.videoDetails?.videoId === expectedVideoId) {
            inspectPlayerResponse(response)
                .catch(error => console.debug("Could not inspect ytInitialPlayerResponse", error));
            return;
        }

        if (attemptsLeft > 0) {
            setTimeout(() => inspectWindowPlayerResponse(expectedVideoId, attemptsLeft - 1), 500);
        } else {
            postStatus(expectedVideoId, "unavailable", "matching YouTube player response was not observed");
        }
    }

    // override window.fetch to intercept requests to the YouTube caption and player endpoint
    window.fetch = async (...args) => {
        const [resource] = args;
        const url = resource instanceof Request ? resource.url : String(resource);
        const response = await originalFetch(...args);
        if (!captureEnabled) return response;

        if (url.includes("/api/timedtext")) {
            const videoId = new URL(url, location.href).searchParams.get("v");
            if (!videoId || videoId !== currentVideoId() || isAdPlaying()) return response;
            response.clone().text()
                .then(body => deliverTranscript(videoId, body, false))
                .catch(error => {
                    postStatus(videoId, "fetch-error", String(error));
                    console.debug("Could not read intercepted transcript", error);
                });
        } else if (url.includes("/youtubei/v1/player")) {
            response.clone().json()
                .then(inspectPlayerResponse)
                .catch(error => console.debug("Could not inspect YouTube player response", error));
        }
        return response;
    };

    // store the original XMLHttpRequest methods
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    // Override the XMLHttpRequest.open method to capture the URL
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.__notsponsoredUrl = String(url);
        return originalOpen.apply(this, [method, url, ...rest]);
    };

    // intercept XHR requests to the YouTube caption endpoint and player endpoint
    XMLHttpRequest.prototype.send = function (...args) {
        const url = this.__notsponsoredUrl;
        if (!captureEnabled) return originalSend.apply(this, args);
        // intercept the /api/timedtext endpoint for the transcription
        if (url?.includes("/api/timedtext")) {
            this.addEventListener("load", () => {
                if (!captureEnabled) return;
                const videoId = new URL(url, location.href).searchParams.get("v");
                if (!videoId || videoId !== currentVideoId() || isAdPlaying()) return;
                try {
                    const body = typeof this.response === "string" ? this.response : this.responseText;
                    deliverTranscript(videoId, body, false);
                } catch (error) {
                    postStatus(videoId, "fetch-error", String(error));
                    console.debug("Could not read intercepted XHR transcript", error);
                }
            });
            // intercept the player endpoint for the caption track list and video id
        } else if (url?.includes("/youtubei/v1/player")) {
            this.addEventListener("load", () => {
                if (!captureEnabled) return;
                try {
                    const playerResponse = this.responseType === "json"
                        ? this.response
                        : JSON.parse(this.responseText);
                    inspectPlayerResponse(playerResponse)
                        .catch(error => console.debug("Could not inspect YouTube XHR player response", error));
                } catch (error) {
                    console.debug("Could not parse YouTube XHR player response", error);
                }
            });
        }
        return originalSend.apply(this, args);
    };

    // event listener that handles messages from the content script
    window.addEventListener("message", event => {
        if (event.source !== window) return;
        if (event.data?.type === "SET_YT_TRANSCRIPT_CAPTURE") {
            captureEnabled = event.data.enabled === true;
            return;
        }
        if (event.data?.type === "REQUEST_YT_TRANSCRIPT" && captureEnabled) {
            inspectWindowPlayerResponse(event.data.videoId);
        }
    });
})();
