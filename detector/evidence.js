import {HIGH_PRECISION_GROUPS, SIGNAL_WEIGHTS} from "./config.js";

// find evidence windows in the given events and features
export function evidenceWindows(events, features, options) {
    const seeds = [];
    let left = 0;
    const counts = new Map();
    let activeCluster = null;

    function flushCluster() {
        if (activeCluster) seeds.push(activeCluster.best);
        activeCluster = null;
    }

    for (let right = 0; right < events.length; right++) {
        if (features[right].commercialScore > 0) {
            for (const group of features[right].groups) {
                counts.set(group, (counts.get(group) ?? 0) + 1);
            }
        }

        while (
            left < right
            && events[right].endMs - events[left].startMs
            > options.evidenceWindowMs
            ) {
            if (features[left].commercialScore > 0) {
                for (const group of features[left].groups) {
                    const next = (counts.get(group) ?? 1) - 1;
                    if (next <= 0) counts.delete(group);
                    else counts.set(group, next);
                }
            }
            left++;
        }

        const hasHighPrecisionSignal = [...HIGH_PRECISION_GROUPS]
            .some(group => counts.has(group));
        const windowScore = [...counts.keys()].reduce(
            (total, group) => total + (SIGNAL_WEIGHTS[group] ?? 0),
            0,
        );
        const qualifies = windowScore >= options.evidenceEntryScore
            && counts.size >= 2
            && hasHighPrecisionSignal;
        if (!qualifies) {
            flushCluster();
            continue;
        }
        // We have a valid window, so we can consider it for the cluster.
        const window = {
            startIndex: left,
            endIndex: right,
            kind: "commercial-window",
            score: windowScore,
        };
        if (!activeCluster) {
            activeCluster = {best: window};
        } else if (
            window.score > activeCluster.best.score
            || (
                window.score === activeCluster.best.score
                && window.startIndex > activeCluster.best.startIndex
            )
        ) {
            activeCluster.best = window;
        }
    }
    flushCluster();
    return seeds;
}


// find the first index of an event that ends at or after the given time
export function findFirstIndexAtOrAfter(events, timeMs) {
    for (let i = 0; i < events.length; i++) {
        if (events[i].endMs >= timeMs) return i;
    }
    return Math.max(0, events.length - 1);
}

// find the last index of an event that ends at or before the given time
export function findLastIndexEndingAtOrBefore(
    events,
    timeMs,
    minimumIndex = 0,
) {
    let result = Math.min(
        Math.max(0, minimumIndex),
        Math.max(0, events.length - 1),
    );
    for (let i = minimumIndex; i < events.length; i++) {
        if (events[i].endMs <= timeMs) result = i;
    }
    return result;
}
