import assert from "node:assert/strict";
import test from "node:test";
import {evidenceWindows, findFirstIndexAtOrAfter, findLastIndexEndingAtOrBefore,} from "../detector/evidence.js";

test("interval helpers handle overlapping events with non-monotonic ends", () => {
    const events = [
        {startMs: 0, endMs: 40, text: "long overlapping caption"},
        {startMs: 10, endMs: 20, text: "short caption"},
        {startMs: 20, endMs: 30, text: "later short caption"},
    ];

    assert.equal(findFirstIndexAtOrAfter(events, 25), 0);
    assert.equal(findLastIndexEndingAtOrBefore(events, 30), 2);
});

test("repeated overlapping copies of the same signals do not inflate evidence", () => {
    const events = [
        {startMs: 0, endMs: 8_000, text: "caption one"},
        {startMs: 2_000, endMs: 10_000, text: "caption two"},
        {startMs: 4_000, endMs: 12_000, text: "caption three"},
    ];
    const features = events.map(() => ({
        commercialScore: 7,
        groups: new Set(["url", "cta"]),
    }));

    assert.deepEqual(evidenceWindows(events, features, {
        evidenceWindowMs: 50_000,
        evidenceEntryScore: 12,
    }), []);
});
