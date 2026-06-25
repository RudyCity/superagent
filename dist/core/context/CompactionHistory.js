import fs from "fs/promises";
import path from "path";
export class CompactionHistory {
    events = [];
    maxHistory = 50;
    filePath;
    isLoaded = false;
    loadingPromise;
    constructor(filePath) {
        this.filePath = filePath;
        if (filePath) {
            this.loadingPromise = this.load()
                .then(() => {
                this.isLoaded = true;
            })
                .catch(() => {
                this.isLoaded = true;
            });
        }
        else {
            this.isLoaded = true;
            this.loadingPromise = Promise.resolve();
        }
    }
    async record(event) {
        if (!this.isLoaded) {
            await this.loadingPromise;
        }
        this.events.push(event);
        if (this.events.length > this.maxHistory) {
            this.events = this.events.slice(-this.maxHistory);
        }
        if (this.filePath) {
            this.save().catch((err) => {
                console.error("Failed to save compaction history:", err);
            });
        }
    }
    getHistory() {
        return [...this.events];
    }
    getLastSummary() {
        for (let i = this.events.length - 1; i >= 0; i--) {
            if (this.events[i].strategy === "summarization") {
                return this.events[i];
            }
        }
        return null;
    }
    getTokensSaved() {
        return this.events.reduce((sum, event) => sum + (event.tokensBefore - event.tokensAfter), 0);
    }
    getCompactionCount() {
        return this.events.length;
    }
    clear() {
        this.events = [];
        if (this.filePath) {
            this.save().catch(() => { });
        }
    }
    async save() {
        if (!this.filePath)
            return;
        try {
            await fs.mkdir(path.dirname(this.filePath), { recursive: true });
            await fs.writeFile(this.filePath, JSON.stringify(this.events, null, 2), "utf-8");
        }
        catch (err) {
            console.error("Failed to save compaction history:", err);
        }
    }
    async load() {
        if (!this.filePath)
            return;
        try {
            const data = await fs.readFile(this.filePath, "utf-8");
            this.events = JSON.parse(data);
        }
        catch (err) {
            if (err.code !== "ENOENT") {
                console.error("Failed to load compaction history:", err);
            }
        }
    }
}
//# sourceMappingURL=CompactionHistory.js.map