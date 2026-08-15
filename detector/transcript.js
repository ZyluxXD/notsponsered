// parse a transcript from is raw JSON
export function parseTranscript(rawJson) {
    const data = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
    if (!Array.isArray(data?.events)) return [];

    return data.events
        .filter(event => Array.isArray(event.segs))
        .map(event => {
            const startMs = Number(event.tStartMs);
            const durationMs = Number(event.dDurationMs) || 3_000;
            return {
                startMs,
                endMs: startMs + Math.max(0, durationMs),
                text: event.segs
                    .map(segment => segment.utf8 ?? "")
                    .join("")
                    .replace(/\s+/g, " ")
                    .trim(),
            };
        })
        .filter(event =>
            Number.isFinite(event.startMs)
            && Number.isFinite(event.endMs)
            && event.text.length > 1)
        .sort((a, b) =>
            a.startMs - b.startMs
            || a.endMs - b.endMs
            || a.text.localeCompare(b.text));
}