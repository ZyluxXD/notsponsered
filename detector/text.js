// normalize text for processing
export function normalizeText(text) {
    return String(text ?? "")
        .normalize("NFKC")
        .replace(/[’‘]/g, "'")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

// normalize text for fuzzy matching
export function normalizeForFuzzy(text) {
    return normalizeText(text)
        .replace(/[^a-z0-9%$]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// check if a text matches any of the provided regex patterns
export function matchesAny(text, patterns) {
    return patterns.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(text);
    });
}

// find ngrams of a given size in a string
function ngrams(value, size) {
    const padded = ` ${value} `;
    const result = [];
    for (let i = 0; i + size <= padded.length; i++) {
        result.push(padded.slice(i, i + size));
    }
    return result;
}

// calculates the Sørensen–Dice similarity coefficient based on shared n-grams
export function diceCoefficient(a, b, size = 3) {
    if (a === b) return 1;
    if (!a || !b) return 0;

    const leftGrams = ngrams(a, size);
    const rightGrams = ngrams(b, size);
    const left = new Map();
    for (const gram of leftGrams) {
        left.set(gram, (left.get(gram) ?? 0) + 1);
    }

    let overlap = 0;
    for (const gram of rightGrams) {
        const count = left.get(gram) ?? 0;
        if (count > 0) {
            overlap++;
            left.set(gram, count - 1);
        }
    }
    return (2 * overlap) / (leftGrams.length + rightGrams.length);
}

// check if a text contains a fuzzy match for any of the given phrases
export function fuzzyPhraseMatch(text, phrases, threshold = 0.82) {
    const normalized = normalizeForFuzzy(text);
    if (!normalized || normalized.length > 500) return false;
    const words = normalized.split(" ");

    for (const phrase of phrases) {
        const target = normalizeForFuzzy(phrase);
        if (normalized.includes(target)) return true;
        const targetLength = target.split(" ").length;
        const minimumWindow = Math.max(2, targetLength - 1);
        const maximumWindow = Math.min(words.length, targetLength + 2);

        for (let size = minimumWindow; size <= maximumWindow; size++) {
            for (let i = 0; i + size <= words.length; i++) {
                const window = words.slice(i, i + size).join(" ");
                if (diceCoefficient(window, target) >= threshold) return true;
            }
        }
    }
    return false;
}

// check if a text contains a fuzzy match for any of the given sponsor words
export function hasFuzzySponsorWord(text) {
    const targets = ["sponsor", "sponsored", "sponsoring", "sponsorship"];
    return normalizeForFuzzy(text).split(" ").some(word =>
        word.length >= 6
        && targets.some(target => diceCoefficient(word, target) >= 0.78));
}
