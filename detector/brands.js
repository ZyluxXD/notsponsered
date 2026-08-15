import {normalizeText} from "./text.js";
import {BRAND_BLOCKLIST, THIRD_PARTY_BRAND_PATTERNS} from "./patterns.js";
import {HIGH_PRECISION_GROUPS, SIGNAL_WEIGHTS} from "./config.js";
import {extractPromoCodeTokens} from "./features.js";

// extraction of domain roots from a text
function extractDomainRoots(text) {
    const normalized = normalizeText(text);
    const roots = new Set();
    const domainPattern =
        /\b([a-z0-9-]{3,})\s*(?:\.| dot )(?:com|io|co|gg|net|org|app|tv|ai|me|dev|tech|store|shop|games|cloud|xyz|ly|link|site)\b/g;

    for (const match of normalized.matchAll(domainPattern)) {
        if (!BRAND_BLOCKLIST.has(match[1])) roots.add(match[1]);
    }
    return roots;
}

// extract candidate brand seeds
function extractCandidateBrandSeeds(
    text,
    feature,
    globallyExcludedTokens,
) {
    const normalized = normalizeText(text);
    const seeds = new Map();
    const promoCodeTokens = extractPromoCodeTokens(text);

    for (const root of extractDomainRoots(normalized)) seeds.set(root, 3);
    for (const pattern of THIRD_PARTY_BRAND_PATTERNS) {
        pattern.lastIndex = 0;
        const token = pattern.exec(normalized)?.[1]?.toLowerCase();
        if (token && !BRAND_BLOCKLIST.has(token)) {
            seeds.set(token, Math.max(seeds.get(token) ?? 0, 3));
        }
    }

    const hasCue = [...feature.groups].some(group =>
        HIGH_PRECISION_GROUPS.has(group) || group === "sponsor");
    if (!hasCue) return seeds;

    for (const match of String(text).matchAll(/\b[A-Z][A-Za-z0-9-]{3,}\b/g)) {
        const token = match[0].toLowerCase();
        if (
            !BRAND_BLOCKLIST.has(token)
            && !promoCodeTokens.has(token)
            && !globallyExcludedTokens.has(token)
        ) {
            seeds.set(token, Math.max(seeds.get(token) ?? 0, 2));
        }
    }
    return seeds;
}

// tokenize a text into a set of normalized tokens
function tokenSet(text) {
    return new Set(normalizeText(text).match(/[a-z][a-z0-9-]{2,}/g) ?? []);
}

// add repeated brand evidence to features based on nearby mentions of candidate brands
export function addRepeatedBrandEvidence(events, features, options) {
    const eventTokens = events.map(event => tokenSet(event.text));
    const tokenMentions = new Map();
    for (let i = 0; i < eventTokens.length; i++) {
        for (const token of eventTokens[i]) {
            const indices = tokenMentions.get(token) ?? [];
            indices.push(i);
            tokenMentions.set(token, indices);
        }
    }

    const globalPromoCodeTokens = new Set();

    for (const event of events) {
        for (const token of extractPromoCodeTokens(event.text)) {
            globalPromoCodeTokens.add(token);
        }
    }

    const seeds = new Map();
    for (let i = 0; i < events.length; i++) {
        for (const [token, strength] of extractCandidateBrandSeeds(
            events[i].text,
            features[i],
            globalPromoCodeTokens,
        )) {
            const previous = seeds.get(token)
                ?? {strength: 0, sourceIndices: []};
            previous.strength = Math.max(previous.strength, strength);
            previous.sourceIndices.push(i);
            seeds.set(token, previous);
        }
    }

    for (const [brand, seed] of seeds) {
        const mentions = tokenMentions.get(brand) ?? [];
        const repeatedNearby = mentions.some((index, position) =>
            position > 0
            && events[index].startMs - events[mentions[position - 1]].endMs
            <= options.brandWindowMs);
        if (!repeatedNearby) continue;

        const sourceTimes = seed.sourceIndices.map(index =>
            events[index].startMs);
        const nearbyMentions = mentions.filter(index =>
            sourceTimes.some(sourceTime =>
                Math.abs(events[index].startMs - sourceTime)
                <= options.brandWindowMs));

        for (const index of nearbyMentions) {
            features[index].brands.add(brand);
            features[index].groups.add("brand");
            const boost = seed.strength >= 3 ? 4 : SIGNAL_WEIGHTS.brand;
            features[index].commercialScore += boost;
            features[index].score += boost;
        }
    }
}
