import fs from "fs";
import path from "path";
import { getGlobalConfigDir } from "./paths.js";
export function listHistorySessions(isMulti = false) {
    const mode = isMulti ? "multi" : "single";
    const historyDir = path.join(getGlobalConfigDir(), "history", mode);
    if (!fs.existsSync(historyDir))
        return [];
    const currentDir = process.cwd();
    const currentSanitized = currentDir.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    let dirs;
    try {
        dirs = fs.readdirSync(historyDir).filter((d) => {
            const nameLower = d.toLowerCase();
            return nameLower === currentSanitized || nameLower.startsWith(currentSanitized + "_");
        });
    }
    catch {
        return [];
    }
    const sessions = [];
    for (const d of dirs) {
        const dirPath = path.join(historyDir, d);
        const filePath = path.join(dirPath, `${d}.json`);
        if (!fs.existsSync(filePath))
            continue;
        try {
            const stat = fs.statSync(filePath);
            const raw = fs.readFileSync(filePath, "utf-8");
            const parsed = JSON.parse(raw);
            let messages = [];
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.messages)) {
                messages = parsed.messages;
            }
            else if (Array.isArray(parsed)) {
                messages = parsed;
            }
            else {
                continue;
            }
            const userMessages = messages.filter((m) => m.role === "user");
            const lastUser = userMessages[userMessages.length - 1];
            const preview = lastUser
                ? lastUser.content.slice(0, 60).replace(/\n/g, " ") + (lastUser.content.length > 60 ? "…" : "")
                : "(no user messages)";
            // Reconstruct display name from sanitized filename as fallback
            // Strip trailing timestamp suffix if present (e.g. _1717999999)
            const cleanName = d.replace(/_\d+$/, "");
            const folderPathName = cleanName
                .replace(/^([a-zA-Z])__/, "$1:\\")
                .replace(/^_+/, "/")
                .replace(/_/g, "/");
            const displayName = lastUser && lastUser.content && lastUser.content.trim()
                ? lastUser.content.trim().slice(0, 60).replace(/\n/g, " ") + (lastUser.content.trim().length > 60 ? "…" : "")
                : folderPathName;
            sessions.push({
                filePath,
                displayName,
                messageCount: messages.length,
                lastModified: stat.mtime,
                preview,
            });
        }
        catch {
            // Skip corrupt/unreadable files
            continue;
        }
    }
    // Sort by most recently modified first
    sessions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
    return sessions;
}
//# sourceMappingURL=history.js.map