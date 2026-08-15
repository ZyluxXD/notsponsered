import {matchesAny, normalizeText} from "./text.js";
import {PRE_ROLL_PATTERNS, SPONSOR_LEAD_IN_PATTERNS,} from "./patterns.js";
import {HIGH_PRECISION_GROUPS} from "./config.js";
import {addGroups, sumGroupWeights} from "./features.js";
import {topicHasReturned} from "./topic.js";
import {findFirstIndexAtOrAfter, findLastIndexEndingAtOrBefore} from "./evidence.js";


// find the start index for a given seed
function findStartForSeed(events, spanAnalysis, seed, options) {
    if (seed.kind === "explicit-start") {
        const seedSpan = spanAnalysis.startSpans.find(span =>
            span.startIndex === seed.startIndex
            && span.endIndex === seed.endIndex);
        if (
            !seedSpan?.feature.endorsementStart
            && !seedSpan?.feature.strongStart
        ) {
            return seed.startIndex;
        }

        const searchStartMs = Math.max(
            0,
            events[seed.startIndex].startMs
            - Math.min(options.startSearchBackMs, 25_000),
        );
        const leadInIndices = [];
        for (
            let i = seed.startIndex;
            i >= 0 && events[i].startMs >= searchStartMs;
            i--
        ) {
            if (matchesAny(
                normalizeText(events[i].text),
                SPONSOR_LEAD_IN_PATTERNS,
            )) {
                leadInIndices.push(i);
            }
        }
        return leadInIndices.length >= 2
            ? Math.min(...leadInIndices)
            : seed.startIndex;
    }

    const seedStartMs = events[seed.startIndex].startMs;
    const searchStartMs = Math.max(0, seedStartMs - options.startSearchBackMs);
    const matchingStarts = spanAnalysis.startSpans
        .filter(span => events[span.startIndex].startMs >= searchStartMs && span.startIndex <= seed.endIndex)
        .sort((a, b) => b.startIndex - a.startIndex);

    let startIndex = matchingStarts[0]?.startIndex ?? seed.startIndex;
    if (!matchingStarts.length) {
        for (let i = startIndex - 1; i >= 0 && events[i].startMs >= searchStartMs; i--) {
            if (matchesAny(normalizeText(events[i].text), PRE_ROLL_PATTERNS)) {
                startIndex = i;
                break;
            }
        }
    }
    return startIndex;
}

// classify a candidate into a sponsor category
function classifyCandidate({
                               explicitStart, selfPromotion, affiliate, hasThirdPartyBrand, groups,
                           }) {
    if (selfPromotion && !affiliate && !groups.has("sponsor")) {
        return "self-promotion";
    }
    if (explicitStart) return "paid-sponsor";
    if (affiliate && !groups.has("sponsor")) return "affiliate";
    if (groups.has("sponsor") || (hasThirdPartyBrand && [...HIGH_PRECISION_GROUPS].some(group => groups.has(group)))) {
        return "paid-sponsor";
    }
    return "commercial-unknown";
}


// follows one candidate through the SPONSOR and END_PENDING states.
export function collectCandidate(events, features, spanAnalysis, seed, topicIndex, options,) {
    const startIndex = findStartForSeed(events, spanAnalysis, seed, options,);
    const startMs = events[startIndex].startMs;
    const searchEndMs = startMs + options.maxSegmentMs;
    const preSponsorTopic = topicIndex.vectorBetween(Math.max(0, startMs - options.topicLookbackMs), Math.max(0, startMs - 1),);

    const endSpansByEnd = new Map();
    for (const span of spanAnalysis.endSpans) {
        const values = endSpansByEnd.get(span.endIndex) ?? [];
        values.push(span);
        endSpansByEnd.set(span.endIndex, values);
    }

    let state = "SPONSOR";
    let rollingLeft = startIndex;
    let rollingScore = 0;
    const rollingGroupCounts = new Map();
    let lastMeaningfulIndex = startIndex;
    let lastStrongIndex = startIndex;
    let endIndex = startIndex;
    let endMs = null;
    let endReason = "low-evidence-timeout";
    let explicitEnd = false;
    let boundaryResolved = false;
    let lastVisitedIndex = startIndex;
    const relevantStartSpans = spanAnalysis.startSpans.filter(span =>
        (
            span.startIndex === startIndex
            && span.endIndex <= Math.max(seed.endIndex, startIndex + 3)
        )
        || (
            seed.kind === "explicit-start"
            && span.startIndex === seed.startIndex
            && span.endIndex === seed.endIndex
        ));
    const strongExplicitStart = relevantStartSpans.some(
        span => span.feature.strongStart,
    );
    const contextualExplicitStart = relevantStartSpans.some(
        span => span.feature.contextualStart,
    );
    const selfPromotionExplicitStart = relevantStartSpans.some(
        span => span.feature.selfPromotionStart,
    );
    const explicitStart = strongExplicitStart
        || contextualExplicitStart
        || selfPromotionExplicitStart;
    const startsSelfPromotion = features
        .slice(startIndex, Math.max(seed.endIndex, startIndex) + 1)
        .some(feature =>
            (feature.selfPromotionStart || feature.selfPromotion)
            && !feature.groups.has("sponsor"));
    const groups = new Set();
    const brands = new Set();
    const negativeGroups = new Set();
    let selfPromotion = false;
    let affiliate = false;
    let hasHighPrecisionEvidence = false;

    for (let i = startIndex; i < events.length && events[i].startMs <= searchEndMs; i++) {
        lastVisitedIndex = i;
        const feature = features[i];
        if (
            i > startIndex
            && state === "END_PENDING"
            && feature.startsSponsor
            && !(
                seed.kind === "explicit-start"
                && i >= seed.startIndex
                && i <= seed.endIndex
            )
        ) {
            const tailTarget = events[lastMeaningfulIndex].endMs
                + options.unmarkedTailMs;
            endIndex = findLastIndexEndingAtOrBefore(
                events,
                tailTarget,
                lastMeaningfulIndex,
            );
            endMs = Math.min(tailTarget, events[i].startMs);
            boundaryResolved = true;
            break;
        }
        addGroups(groups, feature.groups);
        addGroups(negativeGroups, feature.negativeGroups);
        addGroups(brands, feature.brands);
        selfPromotion ||= feature.selfPromotion;
        affiliate ||= feature.affiliate;

        if (feature.commercialScore > 0) {
            for (const group of feature.groups) {
                rollingGroupCounts.set(
                    group,
                    (rollingGroupCounts.get(group) ?? 0) + 1,
                );
            }
        }
        while (rollingLeft < i && events[i].endMs - events[rollingLeft].startMs > options.stayWindowMs) {
            if (features[rollingLeft].commercialScore > 0) {
                for (const group of features[rollingLeft].groups) {
                    const next = (rollingGroupCounts.get(group) ?? 1) - 1;
                    if (next <= 0) rollingGroupCounts.delete(group);
                    else rollingGroupCounts.set(group, next);
                }
            }
            rollingLeft++;
        }
        rollingScore = sumGroupWeights(rollingGroupCounts.keys());

        const isMeaningful = feature.commercialScore >= 1;
        const isStrong = feature.startsSponsor || feature.commercialScore >= 4 || [...feature.groups].some(group => HIGH_PRECISION_GROUPS.has(group));

        if (isMeaningful) lastMeaningfulIndex = i;
        if (isStrong) lastStrongIndex = i;
        hasHighPrecisionEvidence ||= [...feature.groups]
            .some(group => HIGH_PRECISION_GROUPS.has(group));

        const possibleEnds = endSpansByEnd.get(i) ?? [];
        const validEnd = possibleEnds
            .filter(span =>
                span.startIndex >= startIndex
                && events[span.endIndex].endMs - startMs
                >= options.minSegmentMs)
            .sort((left, right) =>
                right.startIndex - left.startIndex
                || right.endIndex - left.endIndex)[0];
        if (validEnd) {
            if (validEnd.feature.endsBeforeEvent) {
                endIndex = Math.max(startIndex, validEnd.startIndex - 1);
                endMs = events[validEnd.startIndex].startMs;
            } else {
                endIndex = validEnd.endIndex;
            }
            endReason = "explicit-boundary";
            explicitEnd = true;
            boundaryResolved = true;
            break;
        }

        const nextEventStartMs = events[i + 1]?.startMs ?? events[i].endMs;
        const evidenceFrontierMs = Math.max(
            events[i].startMs,
            Math.min(events[i].endMs, nextEventStartMs),
        );
        const lowEvidenceMs = Math.max(
            0,
            evidenceFrontierMs - events[lastMeaningfulIndex].endMs,
        );
        const strongSignalAgeMs = Math.max(
            0,
            evidenceFrontierMs - events[lastStrongIndex].endMs,
        );
        const isInsideQualifyingSeed =
            seed.kind === "commercial-window"
            && i <= seed.endIndex;
        const overlappingNextHasEvidence = i + 1 < events.length
            && events[i + 1].startMs < events[i].endMs
            && features[i + 1].commercialScore > 0;
        const evidenceIsActive = isInsideQualifyingSeed
            || feature.commercialScore > 0
            || overlappingNextHasEvidence
            || rollingScore >= options.stayScore
            || strongSignalAgeMs < options.strongSignalGraceMs;

        if (evidenceIsActive) {
            state = "SPONSOR";
            endIndex = i;
            continue;
        }

        if (state === "SPONSOR" && lowEvidenceMs >= options.endPendingAfterMs) {
            state = "END_PENDING";
        }

        if (state !== "END_PENDING") {
            endIndex = i;
            continue;
        }

        if (
            (!explicitStart || startsSelfPromotion)
            && topicHasReturned(topicIndex, preSponsorTopic, events, i, options,)
        ) {
            const topicWindowStart = events[i].endMs - options.topicWindowMs;
            const returnIndex = findFirstIndexAtOrAfter(events, topicWindowStart,);
            endIndex = Math.max(startIndex, returnIndex - 1);
            endReason = "topic-resumption";
            boundaryResolved = true;
            break;
        }

        const noEvidenceTimeoutMs = startsSelfPromotion
            ? options.selfPromotionNoEvidenceTimeoutMs
            : explicitStart
                ? hasHighPrecisionEvidence
                    ? options.explicitStartNoEvidenceTimeoutMs
                    : options.explicitStartInitialEvidenceTimeoutMs
                : options.noEvidenceTimeoutMs;
        if (lowEvidenceMs >= noEvidenceTimeoutMs) {
            const tailTarget = events[lastMeaningfulIndex].endMs + options.unmarkedTailMs;
            endIndex = findLastIndexEndingAtOrBefore(events, tailTarget, lastMeaningfulIndex,);
            endMs = Math.min(tailTarget, searchEndMs);
            endReason = "low-evidence-timeout";
            boundaryResolved = true;
            break;
        }
        endIndex = i;
    }

    if (!boundaryResolved) {
        const tailTarget = events[lastMeaningfulIndex].endMs
            + options.unmarkedTailMs;
        endMs = Math.min(
            events[lastVisitedIndex].endMs,
            tailTarget,
            searchEndMs,
        );
        endIndex = startIndex;
        for (let i = startIndex; i <= lastVisitedIndex; i++) {
            if (events[i].startMs < endMs) endIndex = i;
        }
    }

    groups.clear();
    brands.clear();
    negativeGroups.clear();
    selfPromotion = false;
    affiliate = false;
    for (let i = startIndex; i <= lastVisitedIndex; i++) {
        const isInsideCandidate = endMs === null
            ? i <= endIndex
            : events[i].startMs < endMs;
        if (!isInsideCandidate) continue;
        addGroups(groups, features[i].groups);
        addGroups(negativeGroups, features[i].negativeGroups);
        addGroups(brands, features[i].brands);
        selfPromotion ||= features[i].selfPromotion;
        affiliate ||= features[i].affiliate;
    }

    const uniqueEvidenceScore = sumGroupWeights(groups);
    const hasHighPrecision = [...HIGH_PRECISION_GROUPS]
        .some(group => groups.has(group));
    const hasCorroboration =
        uniqueEvidenceScore >= options.evidenceEntryScore
        && groups.size >= 2
        && hasHighPrecision;
    if (negativeGroups.has("explicitNegation") && !groups.has("affiliate")) {
        return null;
    }
    if (negativeGroups.has("exampleOrMeta") && !groups.has("affiliate")) {
        return null;
    }
    if (
        negativeGroups.has("productDiscussion")
        && !strongExplicitStart
        && uniqueEvidenceScore < options.evidenceEntryScore + 8
    ) {
        return null;
    }
    if (
        contextualExplicitStart
        && !strongExplicitStart
        && !selfPromotionExplicitStart
        && !hasCorroboration
    ) {
        return null;
    }
    if (!explicitStart && !hasCorroboration) {
        return null;
    }

    const hasThirdPartyBrand = brands.size > 0;
    const category = classifyCandidate({
        explicitStart, selfPromotion, affiliate, hasThirdPartyBrand, groups,
    });
    const confidence = explicitEnd
        ? "high"
        : explicitStart
            ? "medium"
            : uniqueEvidenceScore >= options.evidenceEntryScore + 8
                ? "medium"
                : "low";

    return {
        startIndex,
        endIndex,
        endMs,
        confidence,
        reason: explicitStart && endReason !== "explicit-boundary" ? `explicit-start+${endReason}` : endReason,
        category,
        score: uniqueEvidenceScore,
        groups: [...groups].sort(),
        brands: [...brands].sort(),
    };
}
