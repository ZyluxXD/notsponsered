import {cloneFeature, combineFeatures, featureForText} from "./features.js";

// build and return a span analysis
export function buildSpanAnalysis(events, baseFeatures, options) {
    const features = baseFeatures.map(cloneFeature);
    const startSpans = [];
    const endSpans = [];

    for (let startIndex = 0; startIndex < events.length; startIndex++) {
        let text = "";
        for (let endIndex = startIndex; endIndex < events.length && endIndex < startIndex + options.maxSpanEvents; endIndex++) {
            const spanDuration = events[endIndex].endMs - events[startIndex].startMs;
            if (endIndex > startIndex && spanDuration > options.maxSpanMs) {
                break;
            }

            text += `${text ? " " : ""}${events[endIndex].text}`;
            const spanFeature = endIndex === startIndex ? baseFeatures[startIndex] : featureForText(text);
            if (endIndex > startIndex) {
                combineFeatures(features[endIndex], spanFeature);
            }

            if (spanFeature.startsSponsor) {
                startSpans.push({startIndex, endIndex, feature: spanFeature});
            }
            if (spanFeature.endsSponsor) {
                endSpans.push({startIndex, endIndex, feature: spanFeature});
            }
        }
    }

    const uniqueKey = span => `${span.startIndex}:${span.endIndex}`;
    return {
        features,
        startSpans: [...new Map(startSpans.map(span => [uniqueKey(span), span]),).values()],
        endSpans: [...new Map(endSpans.map(span => [uniqueKey(span), span]),).values()],
    };
}
