import assert from "node:assert/strict";
import test from "node:test";
import {evaluateSponsorDetector} from "../detector/evaluation.js";

test("evaluates an enabled self-promotion as a correct classification", () => {
    const result = evaluateSponsorDetector([{
        durationMs: 30_000,
        events: [
            {
                startMs: 0,
                endMs: 8_000,
                text: "Merch alert. Check out my merch in the channel store.",
            },
            {
                startMs: 8_000,
                endMs: 16_000,
                text: "Now back to the video.",
            },
            {
                startMs: 16_000,
                endMs: 30_000,
                text: "We begin by removing the old panel.",
            },
        ],
        truth: [{
            startMs: 0,
            endMs: 16_000,
            category: "self-promotion",
        }],
    }]);

    assert.equal(result.sponsorSecondPrecision, 1);
    assert.equal(result.sponsorSecondRecall, 1);
    assert.equal(result.falseSkippedSecondsPerVideoHour, 0);
    assert.equal(result.selfPromotionConfusionRate, 0);
    assert.equal(result.counts.truthSegments, 1);
    assert.equal(result.counts.detectedTruthSegments, 1);
});
