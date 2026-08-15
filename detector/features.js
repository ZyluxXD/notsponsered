import {NEGATIVE_WEIGHTS, SIGNAL_WEIGHTS} from "./config.js";
import {fuzzyPhraseMatch, hasFuzzySponsorWord, matchesAny, normalizeText} from "./text.js";
import {
    CONTEXTUAL_START_PATTERNS,
    END_BEFORE_PATTERNS,
    END_PATTERNS,
    ENDORSEMENT_START_PATTERNS,
    FUZZY_END_PHRASES,
    FUZZY_START_PHRASES,
    NEGATIVE_PATTERN_GROUPS,
    SELF_PROMOTION_PATTERNS,
    SELF_PROMOTION_START_PATTERNS,
    SIGNAL_PATTERNS,
    STRONG_START_PATTERNS,
} from "./patterns.js";

// some generic nouns that are often used in sponsorship contexts, but aren't specific to brands
const GENERIC_SPONSOR_ROLE_NOUNS = new Set([
    "program",
    "programme",
    "initiative",
    "project",
    "club",
    "team",
    "group",
    "organization",
    "organisation",
    "department",
    "school",
    "university",
    "event",
    "tournament",
    "conference",
    "role",
]);

// some common predicates that indicate a current sponsorship relationship
const CURRENT_SPONSOR_PREDICATES = new Set([
    "is",
    "can",
    "will",
    "help",
    "helps",
    "offer",
    "offers",
    "provide",
    "provides",
    "make",
    "makes",
    "let",
    "lets",
    "allow",
    "allows",
]);

// tokenize a text into words for sponsor detection
// this helps to normalize youtube caption output better
// because captions often have bad sentence structure,
// especially in auto generated captions
function wordsForSponsorStructure(text) {
    return text
        .replace(/[^a-z0-9']+/g, " ")
        .replace(/'/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean);
}

// find a current sponsorship disclosure using the relationship between the
// words, rather than by requiring one fixed sentences - like "this video is
// sponsored by". This help to cover reordered speech/ASR such as "they are, for this
// video, the sponsor" while also excluding normal mentions such as "sponsors
// appear throughout this video"
function hasStructuralSponsorStart(text) {
    const words = wordsForSponsorStructure(text);
    const contentWords = new Set([
        "video",
        "episode",
        "show",
        "podcast",
    ]);
    const currentWords = new Set(["this", "today", "todays"]);
    const sponsorWord = /^sponsor(?:s|ed|ing|ship)?$/;

    for (let sponsorIndex = 0; sponsorIndex < words.length; sponsorIndex++) {
        if (!sponsorWord.test(words[sponsorIndex])) continue;

        for (let contentIndex = 0; contentIndex < words.length; contentIndex++) {
            if (!contentWords.has(words[contentIndex])) continue;
            const scopeStart = Math.max(0, contentIndex - 2);
            const scopeEnd = Math.min(words.length, contentIndex + 3);
            const isCurrentContent = words
                .slice(scopeStart, scopeEnd)
                .some(word => currentWords.has(word));
            if (!isCurrentContent) continue;
            if (Math.abs(sponsorIndex - contentIndex) > 8) continue;

            const between = words.slice(
                Math.min(sponsorIndex, contentIndex) + 1,
                Math.max(sponsorIndex, contentIndex),
            );
            if (sponsorIndex < contentIndex) {
                if (between.some(word => word === "of" || word === "for")) {
                    return true;
                }
                continue;
            }

            const roleStart = Math.max(0, sponsorIndex - 6);
            const roleWords = words.slice(roleStart, sponsorIndex);
            if (
                !roleWords.includes("about")
                && roleWords.some(word =>
                    word === "is"
                    || word === "are"
                    || word === "re"
                    || word === "be"
                    || word === "as"
                    || word === "s")
            ) {
                return true;
            }
        }
    }
    return false;
}

function hasStructuralSponsorRoleStart(text) {
    const words = wordsForSponsorStructure(text);
    for (let sponsorIndex = 1; sponsorIndex < words.length; sponsorIndex++) {
        if (!/^sponsors?$/.test(words[sponsorIndex])) continue;
        if (
            words[sponsorIndex - 1] !== "our"
            && words[sponsorIndex - 1] !== "the"
        ) {
            continue;
        }

        const roleTarget = words[sponsorIndex + 1];
        // youtube captions many times split "our sponsors like Brand" immediately
        // after "sponsors", so this treats the dangling plural role as contextual so
        // the following events can corroborate it
        if (!roleTarget && words[sponsorIndex] === "sponsors") return true;
        if (!roleTarget) continue;
        if (
            roleTarget === "like"
            || roleTarget === "including"
            || (roleTarget === "such" && words[sponsorIndex + 2] === "as")
        ) {
            const namedTargetIndex = roleTarget === "such"
                ? sponsorIndex + 3
                : sponsorIndex + 2;
            const namedTarget = words[namedTargetIndex];
            if (
                namedTarget
                && !GENERIC_SPONSOR_ROLE_NOUNS.has(namedTarget)
            ) {
                return true;
            }
            continue;
        }
        if (roleTarget === "is") {
            const namedTarget = words[sponsorIndex + 2];
            if (
                namedTarget
                && !GENERIC_SPONSOR_ROLE_NOUNS.has(namedTarget)
            ) {
                return true;
            }
            continue;
        }
        if (GENERIC_SPONSOR_ROLE_NOUNS.has(roleTarget)) continue;

        const predicateEnd = Math.min(words.length, sponsorIndex + 8);
        if (words
            .slice(sponsorIndex + 2, predicateEnd)
            .some(word => CURRENT_SPONSOR_PREDICATES.has(word))) {
            return true;
        }
    }
    return false;
}

// add groups
export function addGroups(target, source) {
    for (const group of source) target.add(group);
}

// sum weights from groups
export function sumGroupWeights(groups) {
    let total = 0;
    for (const group of groups) total += SIGNAL_WEIGHTS[group] ?? 0;
    return total;
}

// extract tokens for promo codes
export function extractPromoCodeTokens(text, normalizedText = null) {
    const original = String(text ?? "");
    const normalized = normalizedText ?? normalizeText(original);
    const tokens = new Set();

    if (!normalized.includes("code")) return tokens;

    const labeledCode =
        /\b(?:promo|promotional|discount|referral)\s+code(?:\s+(?:is|:))?\s+([a-z0-9_-]{3,20})\b/gi;

    for (const match of original.matchAll(labeledCode)) {
        tokens.add(match[1].toLowerCase());
    }

    const ownedCode =
        /\buse\s+(?:my|the)\s+(?:promo\s+|promotional\s+|discount\s+|referral\s+)?code(?:\s+(?:is|:))?\s+([a-z0-9_-]{3,20})\b/gi;

    for (const match of original.matchAll(ownedCode)) {
        tokens.add(match[1].toLowerCase());
    }

    const upperCaseValue =
        /\b[Uu]se\s+[Cc]ode\s+([A-Z0-9_-]{3,20})\b/g;

    for (const match of original.matchAll(upperCaseValue)) {
        tokens.add(match[1].toLowerCase());
    }

    const hasOfferContext =
        /\b(?:\d{1,3}\s?(?:%|percent)\s?off|discount|special offer|save \d{1,3})\b/
            .test(normalized);

    if (hasOfferContext) {
        for (
            const match
            of normalized.matchAll(
            /\buse\s+code\s+([a-z0-9_-]{3,20})\b/g,
        )
            ) {
            tokens.add(match[1]);
        }
    }

    return tokens;
}

// find features in a text
export function featureForText(text) {
    const normalized = normalizeText(text);
    const groups = new Set();
    const negativeGroups = new Set();

    for (const [group, patterns] of Object.entries(SIGNAL_PATTERNS)) {
        if (matchesAny(normalized, patterns)) groups.add(group);
    }
    if (extractPromoCodeTokens(text, normalized).size > 0) {
        groups.add("code");
    }
    if (!groups.has("sponsor") && hasFuzzySponsorWord(normalized)) {
        groups.add("sponsor");
    }

    for (const [group, patterns] of Object.entries(NEGATIVE_PATTERN_GROUPS)) {
        if (matchesAny(normalized, patterns)) negativeGroups.add(group);
    }

    const explicitNotSponsored = negativeGroups.has("explicitNegation");
    if (explicitNotSponsored) groups.delete("sponsor");

    const exactStrongStart = matchesAny(normalized, STRONG_START_PATTERNS);
    const structuralSponsorStart = hasStructuralSponsorStart(normalized);
    const structuralSponsorRoleStart = hasStructuralSponsorRoleStart(
        normalized,
    );
    const exactContextualStart = matchesAny(
        normalized,
        CONTEXTUAL_START_PATTERNS,
    );
    const endorsementStart = structuralSponsorRoleStart || matchesAny(
        normalized,
        ENDORSEMENT_START_PATTERNS,
    );
    const selfPromotionStart = matchesAny(
        normalized,
        SELF_PROMOTION_START_PATTERNS,
    );
    const fuzzyStart = !exactStrongStart
        && !exactContextualStart
        && !selfPromotionStart
        && hasFuzzySponsorWord(normalized)
        && fuzzyPhraseMatch(normalized, FUZZY_START_PHRASES);
    const strongStart = !explicitNotSponsored
        && (exactStrongStart || structuralSponsorStart || fuzzyStart);
    const contextualStart = !explicitNotSponsored
        && (exactContextualStart || structuralSponsorRoleStart);
    const startsSponsor = strongStart
        || contextualStart
        || selfPromotionStart;

    const endsBeforeEvent = matchesAny(normalized, END_BEFORE_PATTERNS);
    const exactEnd = endsBeforeEvent || matchesAny(normalized, END_PATTERNS);
    const mayContainFuzzyEnd =
        /\b(?:thank|thnk|back|bak|continu|cntinu|sponsor|suport|support|out)\w*/
            .test(normalized);
    const endsSponsor = exactEnd
        || (
            mayContainFuzzyEnd
            && fuzzyPhraseMatch(normalized, FUZZY_END_PHRASES, 0.84)
        );
    const selfPromotion = matchesAny(normalized, SELF_PROMOTION_PATTERNS);

    let positiveScore = sumGroupWeights(groups);
    if (startsSponsor) positiveScore += 12;
    if (endsSponsor) positiveScore += 4;

    let negativeScore = 0;
    for (const group of negativeGroups) {
        negativeScore += NEGATIVE_WEIGHTS[group] ?? 0;
    }

    return {
        score: Math.max(0, positiveScore - negativeScore),
        commercialScore: Math.max(
            0,
            sumGroupWeights(groups) - negativeScore,
        ),
        positiveScore,
        negativeScore,
        groups,
        negativeGroups,
        startsSponsor,
        strongStart,
        contextualStart,
        endorsementStart,
        selfPromotionStart,
        endsSponsor,
        endsBeforeEvent,
        explicitNotSponsored,
        selfPromotion,
        affiliate: groups.has("affiliate"),
        brands: new Set(),
    };
}

// create a clone of a feature
export function cloneFeature(feature) {
    return {
        ...feature,
        groups: new Set(feature.groups),
        negativeGroups: new Set(feature.negativeGroups),
        brands: new Set(feature.brands),
    };
}

// combine a source feature into a target feature
export function combineFeatures(target, source) {
    addGroups(target.groups, source.groups);
    addGroups(target.negativeGroups, source.negativeGroups);
    target.startsSponsor ||= source.startsSponsor;
    target.strongStart ||= source.strongStart;
    target.contextualStart ||= source.contextualStart;
    target.endorsementStart ||= source.endorsementStart;
    target.selfPromotionStart ||= source.selfPromotionStart;
    target.endsSponsor ||= source.endsSponsor;
    target.endsBeforeEvent ||= source.endsBeforeEvent;
    target.explicitNotSponsored ||= source.explicitNotSponsored;
    target.selfPromotion ||= source.selfPromotion;
    target.affiliate ||= source.affiliate;
    target.positiveScore = Math.max(target.positiveScore, source.positiveScore);
    target.negativeScore = Math.max(target.negativeScore, source.negativeScore);
    target.score = Math.max(target.score, source.score);
    target.commercialScore = Math.max(
        target.commercialScore,
        Math.max(0, sumGroupWeights(target.groups) - target.negativeScore),
    );
}
