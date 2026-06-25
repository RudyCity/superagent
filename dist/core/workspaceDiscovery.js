import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getRootConfigDir } from "./config/paths.js";
// Ignore directories and files to speed up scanning and avoid clutter
const IGNORED_DIRS = new Set([
    "node_modules",
    ".git",
    ".worktrees",
    "dist",
    "vendor",
    ".agents",
    ".superagent-r",
]);
/**
 * Recursively walks a directory to find all non-ignored files with their sizes and modification times.
 */
async function walkDirectory(dir, baseDir, results = []) {
    let entries = [];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    }
    catch {
        // If directory cannot be read, return empty
        return results;
    }
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(baseDir, fullPath).replace(/\\/g, "/");
        if (entry.isDirectory()) {
            if (IGNORED_DIRS.has(entry.name)) {
                continue;
            }
            await walkDirectory(fullPath, baseDir, results);
        }
        else if (entry.isFile()) {
            try {
                const stat = await fs.promises.stat(fullPath);
                results.push({
                    path: relPath,
                    size: stat.size,
                    mtimeMs: stat.mtimeMs || stat.mtime.getTime(),
                });
            }
            catch {
                // Ignore files that cannot be statted (e.g. locked files)
            }
        }
    }
    return results;
}
/**
 * Calculates a fast fingerprint MD5 hash of the workspace files (sorted paths + sizes + mtimes).
 */
export async function getWorkspaceFingerprint(dir) {
    const resolvedDir = path.resolve(dir);
    const rawFiles = await walkDirectory(resolvedDir, resolvedDir);
    // Sort files deterministically by path
    rawFiles.sort((a, b) => a.path.localeCompare(b.path));
    const fileList = [];
    const files = {};
    let fingerprintString = "";
    for (const f of rawFiles) {
        fileList.push(f.path);
        files[f.path] = { size: f.size, mtimeMs: f.mtimeMs };
        fingerprintString += `${f.path}:${f.size}:${f.mtimeMs}\n`;
    }
    const fingerprint = crypto.createHash("md5").update(fingerprintString).digest("hex");
    return { fingerprint, fileList, files };
}
/**
 * Resolves the cache file path for the given workspace directory.
 */
export function getWorkspaceCachePath(dir) {
    const root = getRootConfigDir();
    const dirHash = crypto.createHash("md5").update(path.resolve(dir)).digest("hex");
    const cacheDir = path.join(root, "workspace-caches");
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    return path.join(cacheDir, `${dirHash}.json`);
}
/**
 * Discovers the workspace: compares current fingerprint with the cache to determine
 * whether a full/partial update is required. Returns isIdentical and the cache.
 */
export async function discoverWorkspace(dir) {
    const resolvedDir = path.resolve(dir);
    const cachePath = getWorkspaceCachePath(resolvedDir);
    const current = await getWorkspaceFingerprint(resolvedDir);
    let cached = null;
    if (fs.existsSync(cachePath)) {
        try {
            cached = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        }
        catch {
            // Ignore reading errors, cache will be overwritten
        }
    }
    if (cached && cached.fingerprint === current.fingerprint) {
        return { isIdentical: true, cache: cached };
    }
    // Workspace has changed or no cache exists. Read agents.md and package.json to populate context.
    const packageJsonPath = path.join(resolvedDir, "package.json");
    const agentsMdPath = path.join(resolvedDir, "agents.md");
    let agentsMd = undefined;
    if (fs.existsSync(agentsMdPath)) {
        try {
            agentsMd = fs.readFileSync(agentsMdPath, "utf-8");
        }
        catch { }
    }
    let packageJson = undefined;
    if (fs.existsSync(packageJsonPath)) {
        try {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        }
        catch { }
    }
    const newCache = {
        workspaceDir: resolvedDir,
        fingerprint: current.fingerprint,
        fileList: current.fileList,
        files: current.files,
        agentsMd,
        packageJson,
        lastScanTime: Date.now(),
    };
    try {
        fs.writeFileSync(cachePath, JSON.stringify(newCache, null, 2), "utf-8");
    }
    catch { }
    return { isIdentical: false, cache: newCache };
}
/**
 * Injects a formatted overview of the workspace files and main configs into the system prompt.
 */
export function injectWorkspaceOverview(systemPrompt, cache) {
    const maxFileListLength = 500;
    let filesText = cache.fileList.slice(0, maxFileListLength).map((f) => `- ${f}`).join("\n");
    if (cache.fileList.length > maxFileListLength) {
        filesText += `\n- ... and ${cache.fileList.length - maxFileListLength} more files (use search/glob tools to see them)`;
    }
    let overview = `\n\n==================================================\n`;
    overview += `📁 WORKSPACE FILES LIST:\n${filesText}\n`;
    if (cache.agentsMd) {
        overview += `\n📄 PROJECT SPECIFICATIONS (agents.md):\n${cache.agentsMd}\n`;
    }
    if (cache.packageJson && cache.packageJson.name) {
        overview += `\n📦 PROJECT METADATA (package.json):\n- Name: ${cache.packageJson.name}\n- Version: ${cache.packageJson.version || "unknown"}\n`;
        if (cache.packageJson.dependencies) {
            overview += `- Dependencies: ${Object.keys(cache.packageJson.dependencies).join(", ")}\n`;
        }
    }
    overview += `==================================================\n`;
    return systemPrompt + overview;
}
//# sourceMappingURL=workspaceDiscovery.js.map