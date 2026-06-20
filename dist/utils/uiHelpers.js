export function stripSgrMouseSequences(value) {
    return value.replace(/(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g, "");
}
export function getInsertion(oldVal, newVal) {
    let start = 0;
    while (start < oldVal.length && start < newVal.length && oldVal[start] === newVal[start]) {
        start++;
    }
    let endOld = oldVal.length - 1;
    let endNew = newVal.length - 1;
    while (endOld >= start && endNew >= start && oldVal[endOld] === newVal[endNew]) {
        endOld--;
        endNew--;
    }
    const prefix = oldVal.slice(0, start);
    const inserted = newVal.slice(start, endNew + 1);
    const suffix = oldVal.slice(endOld + 1);
    return { prefix, inserted, suffix };
}
export function getPasteSplit(currentInput, prefixLen, suffixLen) {
    const prefix = currentInput.slice(0, Math.min(currentInput.length, prefixLen));
    const suffix = suffixLen > 0 ? currentInput.slice(Math.max(prefix.length, currentInput.length - suffixLen)) : "";
    const inserted = currentInput.slice(prefix.length, currentInput.length - suffix.length);
    return { prefix, inserted, suffix };
}
export function getLatestSubagentAction(logs) {
    if (!logs || logs.length === 0)
        return "Initializing...";
    for (let i = logs.length - 1; i >= 0; i--) {
        const raw = logs[i].replace(/\r/g, "").trim();
        if (raw) {
            let clean = raw
                .replace(/^.*?───\[\s*/, "")
                .replace(/\s*\]$/, "")
                .replace(/^[│┌├└─\s]+/, "")
                .trim();
            clean = clean.replace(/^Description:\s*/i, "");
            clean = clean.replace(/^Args:\s*/i, "");
            if (clean) {
                return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
            }
        }
    }
    return "Processing...";
}
export function getLatestSuperagentAction(logs) {
    if (!logs || logs.length === 0)
        return "Initializing...";
    for (let i = logs.length - 1; i >= 0; i--) {
        const raw = logs[i].replace(/\r/g, "").trim();
        if (raw) {
            let clean = raw
                .replace(/^\[THINK\]\s*/i, "")
                .replace(/^\[TOOL:START\]\s*/i, "")
                .replace(/^\[TOOL:SUCCESS\]\s*/i, "")
                .replace(/^\[TOOL:FAILED\]\s*/i, "")
                .replace(/^\[ERROR\]\s*/i, "")
                .replace(/^[│┌├└─\s]+/, "")
                .trim();
            if (clean) {
                return clean.length > 80 ? clean.slice(0, 80) + "..." : clean;
            }
        }
    }
    return "Processing...";
}
export function truncateStreamDisplay(text, maxLines, width) {
    const rawLines = text.split("\n");
    let accumulated = 0;
    const resultLines = [];
    for (let i = rawLines.length - 1; i >= 0; i--) {
        const wrappedCount = Math.max(1, Math.ceil(rawLines[i].length / width));
        if (accumulated + wrappedCount > maxLines) {
            if (resultLines.length === 0) {
                resultLines.unshift(rawLines[i]);
            }
            else {
                resultLines.unshift("... [older output hidden to fit screen] ...");
            }
            break;
        }
        accumulated += wrappedCount;
        resultLines.unshift(rawLines[i]);
    }
    return resultLines.join("\n");
}
//# sourceMappingURL=uiHelpers.js.map