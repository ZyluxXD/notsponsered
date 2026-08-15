import {detectSponsorSegments} from "./detector.js";
import {withDefaults} from "./config.js";

// find the interval intersection
function intervalIntersection(left, right) {
    return Math.max(
        0,
        Math.min(left.endMs, right.endMs)
        - Math.max(left.startMs, right.startMs),
    );
}

// find the interval intersection over union (IoU)
function intervalIoU(left, right) {
    const intersection = intervalIntersection(left, right);
    const union =
        Math.max(left.endMs, right.endMs)
        - Math.min(left.startMs, right.startMs);
    return union > 0 ? intersection / union : 0;
}

// find the total covered duration of a set of segments
function totalCoveredDuration(segments) {
    const merged = [];
    for (
        const segment
        of [...segments].sort((a, b) => a.startMs - b.startMs)
        ) {
        const previous = merged.at(-1);
        if (previous && segment.startMs <= previous.endMs) {
            previous.endMs = Math.max(previous.endMs, segment.endMs);
        } else {
            merged.push({
                startMs: segment.startMs,
                endMs: segment.endMs,
            });
        }
    }
    return merged.reduce(
        (total, segment) => total + segment.endMs - segment.startMs,
        0,
    );
}

// find the overlap duration between two sets of segments
function overlapDuration(predicted, truth) {
    const intersections = [];
    for (const prediction of predicted) {
        for (const actual of truth) {
            const startMs = Math.max(prediction.startMs, actual.startMs);
            const endMs = Math.min(prediction.endMs, actual.endMs);
            if (endMs > startMs) intersections.push({startMs, endMs});
        }
    }
    return totalCoveredDuration(intersections);
}

// find the median of a set of values
function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}


// evaluate timestamp quality
export function evaluateSponsorDetector(videos, detectorOptions = {}) {
    if (!Array.isArray(videos)) {
        throw new TypeError("videos must be an array");
    }

    let predictedMs = 0;
    let truthMs = 0;
    let overlapMs = 0;
    let totalVideoMs = 0;
    let truthSegments = 0;
    let detectedTruthSegments = 0;
    let selfPromotionTruthMs = 0;
    let selfPromotionMistakeMs = 0;
    const startErrorsMs = [];
    const endErrorsMs = [];
    const matchedIoUs = [];
    const evaluationOptions = withDefaults({
        ...detectorOptions,
        includeMetadata: true,
    });
    const evaluatedCategories = new Set(
        evaluationOptions.includedCategories,
    );

    for (const video of videos) {
        const predictions = detectSponsorSegments(
            video.events,
            evaluationOptions,
        );
        const truth = video.truth ?? [];
        const positiveTruth = truth.filter(segment =>
            evaluatedCategories.has(
                segment.category ?? "paid-sponsor",
            ));
        const selfPromotionTruth = truth.filter(segment =>
            segment.category === "self-promotion");

        predictedMs += totalCoveredDuration(predictions);
        truthMs += totalCoveredDuration(positiveTruth);
        overlapMs += overlapDuration(predictions, positiveTruth);
        selfPromotionTruthMs += totalCoveredDuration(selfPromotionTruth);
        selfPromotionMistakeMs += overlapDuration(
            predictions.filter(prediction =>
                prediction.category !== "self-promotion"),
            selfPromotionTruth,
        );
        totalVideoMs += Number(video.durationMs)
            || video.events?.at(-1)?.endMs
            || 0;
        truthSegments += positiveTruth.length;

        for (const actual of positiveTruth) {
            let best = null;
            for (const prediction of predictions) {
                const iou = intervalIoU(prediction, actual);
                if (!best || iou > best.iou) best = {prediction, iou};
            }
            if (best?.iou > 0) {
                detectedTruthSegments++;
                matchedIoUs.push(best.iou);
                startErrorsMs.push(
                    Math.abs(best.prediction.startMs - actual.startMs),
                );
                endErrorsMs.push(
                    Math.abs(best.prediction.endMs - actual.endMs),
                );
            }
        }
    }

    const falsePositiveMs = Math.max(0, predictedMs - overlapMs);
    return {
        sponsorSecondPrecision: predictedMs ? overlapMs / predictedMs : 1,
        sponsorSecondRecall: truthMs ? overlapMs / truthMs : 1,
        falseSkippedSecondsPerVideoHour: totalVideoMs
            ? (falsePositiveMs / 1_000) / (totalVideoMs / 3_600_000)
            : 0,
        medianStartBoundaryErrorMs: median(startErrorsMs),
        medianEndBoundaryErrorMs: median(endErrorsMs),
        meanMatchedSegmentIoU: matchedIoUs.length
            ? matchedIoUs.reduce((sum, value) => sum + value, 0)
            / matchedIoUs.length
            : null,
        wholeSegmentRecall: truthSegments
            ? detectedTruthSegments / truthSegments
            : 1,
        selfPromotionConfusionRate: selfPromotionTruthMs
            ? selfPromotionMistakeMs / selfPromotionTruthMs
            : 0,
        counts: {
            videos: videos.length,
            truthSegments,
            detectedTruthSegments,
        },
    };
}
