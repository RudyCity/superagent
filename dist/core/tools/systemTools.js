import fs from "fs/promises";
import path from "path";
import fg from "fast-glob";
import { execa } from "execa";
import { normalizeForMatching, verifySyntax } from "./helpers.js";
import { getLocalRgPath, isRgInstalledGlobally, ensureRgInstalled } from "../androidSetup.js";
function buildEditSummary(before, after, filePath, existedBefore = true) {
    if (before === after) {
        return `No changes made: ${filePath}`;
    }
    const beforeLines = existedBefore || before.length > 0 ? before.split(/\r?\n/) : [];
    const afterLines = after.length > 0 ? after.split(/\r?\n/) : [];
    const m = beforeLines.length;
    const n = afterLines.length;
    const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = beforeLines[i] === afterLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    let i = 0;
    let j = 0;
    let added = 0;
    let removed = 0;
    const preview = [];
    const pushPreview = (line) => {
        if (preview.length < 16)
            preview.push(line);
    };
    while (i < m || j < n) {
        if (i < m && j < n && beforeLines[i] === afterLines[j]) {
            i++;
            j++;
        }
        else if (j < n && (i === m || dp[i][j + 1] >= dp[i + 1][j])) {
            added++;
            pushPreview(`+ ${afterLines[j]}`);
            j++;
        }
        else if (i < m) {
            removed++;
            pushPreview(`- ${beforeLines[i]}`);
            i++;
        }
    }
    const action = existedBefore ? "Changed" : "Created";
    const previewText = preview.length > 0 ? `\nDiff preview:\n${preview.join("\n")}` : "";
    return `${action}: +${added} -${removed}\nFile: ${filePath}${previewText}`;
}
/**
 * Normalize a file path to fix common LLM path construction errors.
 * Handles:
 *   - Double drive letter prefix: D:\d\backup... → D:\backup...
 *   - Git Bash style paths: /d/backup... → D:\backup... (on Windows)
 */
function normalizePath(filePath) {
    // Fix double drive letter: e.g. "D:\d\backup..." or "C:\c\Users..."
    const doubleDriveMatch = filePath.match(/^([A-Za-z]):\\([a-z])\\(.*)$/);
    if (doubleDriveMatch) {
        const drive = doubleDriveMatch[1].toUpperCase();
        const innerDrive = doubleDriveMatch[2].toLowerCase();
        if (drive.toLowerCase() === innerDrive) {
            return `${drive}:\\${doubleDriveMatch[3]}`;
        }
    }
    return filePath;
}
export const readTool = {
    name: "read",
    description: "Read file contents. Returns lines with line numbers.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Absolute or relative path to the file",
            },
            offset: {
                type: "number",
                description: "Line number to start from (1-indexed)",
            },
            limit: {
                type: "number",
                description: "Max lines to read (default 2000)",
            },
        },
        required: ["filePath"],
    },
    async execute(args, cwd, signal) {
        const filePath = normalizePath(path.resolve(cwd, args.filePath));
        const offset = Math.max(1, args.offset || 1);
        const limit = args.limit || 2000;
        try {
            // Check if path is a directory — list contents instead of failing
            const stat = await fs.stat(filePath);
            if (stat.isDirectory()) {
                const entries = await fs.readdir(filePath, { withFileTypes: true });
                const lines = entries.slice(0, limit).map((entry) => {
                    const suffix = entry.isDirectory() ? "/" : "";
                    return `${entry.name}${suffix}`;
                });
                const header = `Directory: ${filePath} (${entries.length} entries)`;
                return [header, ...lines].join("\n");
            }
            const buffer = await fs.readFile(filePath);
            // Check for binary content (first 1024 bytes check for null bytes)
            const checkLimit = Math.min(buffer.length, 1024);
            for (let i = 0; i < checkLimit; i++) {
                if (buffer[i] === 0) {
                    return `Error: Cannot read binary file ${args.filePath}`;
                }
            }
            const content = buffer.toString("utf-8");
            const lines = content.replace(/\r\n/g, "\n").split("\n");
            const sliced = lines.slice(offset - 1, offset - 1 + limit);
            return sliced.map((line, i) => `${offset + i}: ${line}`).join("\n");
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error reading file: ${message}`;
        }
    },
};
export const writeTool = {
    name: "write",
    description: "Write content to a file. Creates parent directories if needed.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Absolute or relative path to the file",
            },
            content: {
                type: "string",
                description: "Content to write",
            },
        },
        required: ["filePath", "content"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, args.filePath);
        try {
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, args.content, "utf-8");
            return `File written: ${filePath}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error writing file: ${message}`;
        }
    },
};
export const editTool = {
    name: "edit",
    description: "Edit a file by replacing an exact string match (CRLF/LF and trailing whitespace tolerant). Use read first to see content.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Path to the file",
            },
            oldString: {
                type: "string",
                description: "Exact string to find and replace",
            },
            newString: {
                type: "string",
                description: "Replacement string",
            },
            startLine: {
                type: "number",
                description: "Optional line number to start searching from (1-indexed)",
            },
            endLine: {
                type: "number",
                description: "Optional line number to end searching at (1-indexed)",
            },
        },
        required: ["filePath", "oldString", "newString"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, args.filePath);
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const oldStr = args.oldString;
            const newStr = args.newString;
            const startLine = args.startLine ? Math.max(1, args.startLine) : undefined;
            const endLine = args.endLine ? args.endLine : undefined;
            const normContent = normalizeForMatching(content);
            const normOldStr = normalizeForMatching(oldStr);
            let updated;
            if (startLine !== undefined || endLine !== undefined) {
                const lines = content.split(/\r?\n/);
                const normLines = normContent.split("\n");
                const startIdx = startLine !== undefined ? startLine - 1 : 0;
                const endIdx = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
                const targetSubNormContent = normLines.slice(startIdx, endIdx).join("\n");
                if (!targetSubNormContent.includes(normOldStr)) {
                    return `Error: oldString not found within lines ${startLine || 1} to ${endLine || lines.length} of ${filePath} (matching normalized content)`;
                }
                const count = targetSubNormContent.split(normOldStr).length - 1;
                if (count > 1) {
                    return `Error: Found ${count} matches for oldString in the specified line range. Provide more context or a narrower range.`;
                }
                const subContentStartOffset = normLines.slice(0, startIdx).join("\n").length + (startIdx > 0 ? 1 : 0);
                const matchIndexInNorm = normContent.indexOf(normOldStr, subContentStartOffset);
                const sliceText = lines.slice(startIdx, endIdx).join("\n");
                const normSliceText = normalizeForMatching(sliceText);
                const matchIdx = normSliceText.indexOf(normOldStr);
                let normCharIdx = 0;
                let origCharIdx = 0;
                let matchOrigStart = -1;
                let matchOrigEnd = -1;
                while (origCharIdx < content.length && normCharIdx < normContent.length) {
                    if (normCharIdx === matchIndexInNorm) {
                        matchOrigStart = origCharIdx;
                    }
                    if (normCharIdx === matchIndexInNorm + normOldStr.length) {
                        matchOrigEnd = origCharIdx;
                        break;
                    }
                    const cOrig = content[origCharIdx];
                    const cNorm = normContent[normCharIdx];
                    if (cOrig === "\r") {
                        origCharIdx++;
                        continue;
                    }
                    origCharIdx++;
                    normCharIdx++;
                }
                if (matchOrigStart === -1 || matchOrigEnd === -1) {
                    updated = content.replace(oldStr, newStr);
                }
                else {
                    updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
                }
            }
            else {
                if (!normContent.includes(normOldStr)) {
                    return `Error: oldString not found in ${filePath} (matching normalized content)`;
                }
                const count = normContent.split(normOldStr).length - 1;
                if (count > 1) {
                    return `Error: Found ${count} matches for oldString. Provide more context to make it unique, or specify startLine/endLine.`;
                }
                const matchIndexInNorm = normContent.indexOf(normOldStr);
                let normCharIdx = 0;
                let origCharIdx = 0;
                let matchOrigStart = -1;
                let matchOrigEnd = -1;
                while (origCharIdx < content.length && normCharIdx < normContent.length) {
                    if (normCharIdx === matchIndexInNorm) {
                        matchOrigStart = origCharIdx;
                    }
                    if (normCharIdx === matchIndexInNorm + normOldStr.length) {
                        matchOrigEnd = origCharIdx;
                        break;
                    }
                    const cOrig = content[origCharIdx];
                    if (cOrig === "\r") {
                        origCharIdx++;
                        continue;
                    }
                    origCharIdx++;
                    normCharIdx++;
                }
                if (matchOrigStart === -1 || matchOrigEnd === -1) {
                    updated = content.replace(oldStr, newStr);
                }
                else {
                    updated = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
                }
            }
            await fs.writeFile(filePath, updated, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
                return `Warning: ${syntaxError}. Changes applied to file: ${filePath}`;
            }
            return `File edited: ${filePath}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error editing file: ${message}`;
        }
    },
};
export const globTool = {
    name: "glob",
    description: "Find files matching a glob pattern.",
    parameters: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "Glob pattern (e.g. **/*.ts, src/**/*.tsx)",
            },
            path: {
                type: "string",
                description: "Directory to search in (default: cwd)",
            },
            limit: {
                type: "number",
                description: "Maximum number of files to return (default 500)",
            },
        },
        required: ["pattern"],
    },
    async execute(args, cwd, signal) {
        const pattern = args.pattern;
        const searchPath = args.path
            ? path.resolve(cwd, args.path)
            : cwd;
        const limit = args.limit || 500;
        try {
            const files = await fg(pattern, {
                cwd: searchPath,
                absolute: false,
                onlyFiles: true,
                ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
            });
            if (files.length === 0)
                return "No files found.";
            const sliced = files.slice(0, limit);
            const output = sliced.join("\n");
            if (files.length > limit) {
                return `${output}\n\n... (output truncated, showing ${limit} of ${files.length} files)`;
            }
            return output;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error: ${message}`;
        }
    },
};
export const grepTool = {
    name: "grep",
    description: "Search file contents using regex. Returns matching lines.",
    parameters: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "Regex pattern to search for",
            },
            include: {
                type: "string",
                description: "File pattern to include (e.g. *.ts)",
            },
            path: {
                type: "string",
                description: "Directory to search in (default: cwd)",
            },
        },
        required: ["pattern"],
    },
    async execute(args, cwd, signal) {
        const pattern = args.pattern;
        const include = args.include || "*";
        const searchPath = args.path
            ? path.resolve(cwd, args.path)
            : cwd;
        try {
            const files = await fg(`**/${include}`, {
                cwd: searchPath,
                absolute: true,
                onlyFiles: true,
                ignore: ["**/node_modules/**", "**/dist/**", "**/.git/**"],
            });
            const results = [];
            const regex = new RegExp(pattern, "gi");
            const slicedFiles = files.slice(0, 500);
            // Process in batches of 25 files concurrently
            const BATCH_SIZE = 25;
            for (let offset = 0; offset < slicedFiles.length; offset += BATCH_SIZE) {
                const batch = slicedFiles.slice(offset, offset + BATCH_SIZE);
                await Promise.all(batch.map(async (file) => {
                    try {
                        const content = await fs.readFile(file, "utf-8");
                        if (content.includes("\0"))
                            return; // skip binary
                        const lines = content.split(/\r?\n/);
                        const localRegex = new RegExp(pattern, "gi");
                        for (let i = 0; i < lines.length; i++) {
                            if (localRegex.test(lines[i])) {
                                const relPath = path.relative(searchPath, file);
                                results.push(`${relPath}:${i + 1}: ${lines[i].trim()}`);
                            }
                            localRegex.lastIndex = 0;
                        }
                    }
                    catch {
                        // skip unreadable files
                    }
                }));
            }
            return results.length > 0
                ? results.slice(0, 100).join("\n")
                : "No matches found.";
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error: ${message}`;
        }
    },
};
export const ripgrepSearchTool = {
    name: "ripgrep_search",
    description: "Search file contents using ripgrep (rg) if installed. Extremely fast.",
    parameters: {
        type: "object",
        properties: {
            pattern: {
                type: "string",
                description: "The pattern to search for",
            },
            path: {
                type: "string",
                description: "Optional subpath to search within",
            },
        },
        required: ["pattern"],
    },
    async execute(args, cwd, signal) {
        const pattern = args.pattern;
        const searchPath = args.path ? path.resolve(cwd, args.path) : cwd;
        await ensureRgInstalled();
        let rgExe = "rg";
        if (!(await isRgInstalledGlobally())) {
            const localRg = getLocalRgPath();
            try {
                await fs.access(localRg);
                rgExe = localRg;
            }
            catch { }
        }
        try {
            const result = await execa(rgExe, [
                "--vimgrep",
                "--smart-case",
                "--glob", "!node_modules",
                "--glob", "!dist",
                "--glob", "!.git",
                pattern,
                searchPath
            ], {
                reject: false,
                cancelSignal: signal,
            });
            if (result.exitCode === 1) {
                return "No matches found.";
            }
            if (result.exitCode !== 0) {
                return `ripgrep failed with code ${result.exitCode}: ${result.stderr}`;
            }
            const lines = result.stdout.split("\n");
            const truncateOutput = (await import("./helpers.js")).truncateOutput;
            if (lines.length > 100) {
                return lines.slice(0, 100).join("\n") + `\n\n... (showing 100 of ${lines.length} results)`;
            }
            return result.stdout;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `ripgrep error: ${message}. Make sure ripgrep is installed.`;
        }
    },
};
export const writeToFileTool = {
    name: "write_to_file",
    description: "Create a new file or overwrite an existing file's content entirely.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Path to the file to write to",
            },
            content: {
                type: "string",
                description: "The complete content to write to the file",
            },
            overwrite: {
                type: "boolean",
                description: "If true, will overwrite an existing file. If false, will error if the file exists.",
            },
        },
        required: ["filePath", "content"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, args.filePath);
        const overwrite = !!args.overwrite;
        try {
            if (!overwrite) {
                try {
                    await fs.access(filePath);
                    return `Error: File already exists and overwrite was set to false.`;
                }
                catch {
                    // File does not exist, safe to write
                }
            }
            let previousContent = "";
            let existedBefore = true;
            try {
                previousContent = await fs.readFile(filePath, "utf-8");
            }
            catch {
                existedBefore = false;
            }
            const nextContent = args.content;
            const summary = buildEditSummary(previousContent, nextContent, filePath, existedBefore);
            if (previousContent === nextContent && existedBefore) {
                return summary;
            }
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, nextContent, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            const action = existedBefore ? "File written successfully" : "Created file";
            if (syntaxError) {
                return `Warning: ${syntaxError}. ${action}: ${filePath}\n${summary}`;
            }
            return `${action}: ${filePath}\n${summary}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error writing file: ${message}`;
        }
    },
};
export const replaceFileContentTool = {
    name: "replace_file_content",
    description: "Edit a single contiguous block of code in a file by specifying line ranges and target content.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Path to the file to edit",
            },
            targetContent: {
                type: "string",
                description: "The exact target content to replace (including whitespace)",
            },
            replacementContent: {
                type: "string",
                description: "The replacement content",
            },
            startLine: {
                type: "number",
                description: "Start line number of the block to replace (1-indexed)",
            },
            endLine: {
                type: "number",
                description: "End line number of the block to replace (1-indexed)",
            },
        },
        required: ["filePath", "targetContent", "replacementContent", "startLine", "endLine"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, (args.filePath || args.TargetFile));
        const targetContent = (args.targetContent ?? args.TargetContent ?? "");
        const replacementContent = (args.replacementContent ?? args.ReplacementContent ?? "");
        const startLine = Math.max(1, Number(args.startLine ?? args.StartLine ?? 0));
        const endLine = Math.max(startLine, Number(args.endLine ?? args.EndLine ?? 0));
        try {
            const content = await fs.readFile(filePath, "utf-8");
            const lines = content.split(/\r?\n/);
            if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
                return `Error: Invalid line range [${startLine}, ${endLine}]. File has ${lines.length} lines.`;
            }
            const sliceOfLines = lines.slice(startLine - 1, endLine);
            const sliceText = sliceOfLines.join("\n");
            const normSliceText = normalizeForMatching(sliceText);
            const normTargetContent = normalizeForMatching(targetContent);
            if (!normSliceText.includes(normTargetContent)) {
                return `Error: targetContent not found in specified line range [${startLine}, ${endLine}] (matching normalized content).`;
            }
            const matchIndexInNorm = normSliceText.indexOf(normTargetContent);
            let normCharIdx = 0;
            let origCharIdx = 0;
            let matchOrigStart = -1;
            let matchOrigEnd = -1;
            while (origCharIdx < sliceText.length && normCharIdx < normSliceText.length) {
                if (normCharIdx === matchIndexInNorm) {
                    matchOrigStart = origCharIdx;
                }
                if (normCharIdx === matchIndexInNorm + normTargetContent.length) {
                    matchOrigEnd = origCharIdx;
                    break;
                }
                const cOrig = sliceText[origCharIdx];
                if (cOrig === "\r") {
                    origCharIdx++;
                    continue;
                }
                origCharIdx++;
                normCharIdx++;
            }
            let replacedSlice;
            if (matchOrigStart === -1 || matchOrigEnd === -1) {
                replacedSlice = sliceText.replace(targetContent, replacementContent);
            }
            else {
                replacedSlice = sliceText.slice(0, matchOrigStart) + replacementContent + sliceText.slice(matchOrigEnd);
            }
            const newLines = [
                ...lines.slice(0, startLine - 1),
                replacedSlice,
                ...lines.slice(endLine),
            ];
            const originalEnding = content.includes("\r\n") ? "\r\n" : "\n";
            const nextContent = newLines.join(originalEnding);
            const summary = buildEditSummary(content, nextContent, filePath);
            if (content === nextContent) {
                return summary;
            }
            await fs.writeFile(filePath, nextContent, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
                return `Warning: ${syntaxError}. File updated: ${filePath}\n${summary}`;
            }
            return `File updated successfully: ${filePath}\n${summary}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error replacing file content: ${message}`;
        }
    },
};
export const multiReplaceFileContentTool = {
    name: "multi_replace_file_content",
    description: "Perform multiple non-contiguous edits across a single file simultaneously.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Path to the file to edit",
            },
            chunks: {
                type: "array",
                description: "List of replacement chunks to apply",
                items: {
                    type: "object",
                    properties: {
                        targetContent: {
                            type: "string",
                            description: "The exact content to replace",
                        },
                        replacementContent: {
                            type: "string",
                            description: "The replacement content",
                        },
                        startLine: {
                            type: "number",
                            description: "Start line number of the block to replace (1-indexed)",
                        },
                        endLine: {
                            type: "number",
                            description: "End line number of the block to replace (1-indexed)",
                        },
                    },
                    required: ["targetContent", "replacementContent", "startLine", "endLine"],
                },
            },
        },
        required: ["filePath", "chunks"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, (args.filePath || args.TargetFile));
        const rawChunks = args.chunks || args.ReplacementChunks || args.replacementChunks || [];
        const rawChunksArray = Array.isArray(rawChunks)
            ? rawChunks
            : (rawChunks !== undefined && rawChunks !== null ? [rawChunks] : []);
        const chunks = rawChunksArray.map((c) => {
            if (!c || typeof c !== "object")
                return c;
            const sl = Math.max(1, Number(c.startLine ?? c.StartLine ?? 0));
            return {
                targetContent: c.targetContent ?? c.TargetContent ?? "",
                replacementContent: c.replacementContent ?? c.ReplacementContent ?? "",
                startLine: sl,
                endLine: Math.max(sl, Number(c.endLine ?? c.EndLine ?? 0)),
            };
        });
        if (chunks.length === 0) {
            return "Error: No chunks provided or invalid format.";
        }
        try {
            let content = await fs.readFile(filePath, "utf-8");
            let lines = content.split("\n");
            const sortedChunks = [...chunks].sort((a, b) => b.startLine - a.startLine);
            for (const chunk of sortedChunks) {
                const { targetContent, replacementContent, startLine, endLine } = chunk;
                if (startLine < 1 || startLine > lines.length || endLine < startLine || endLine > lines.length) {
                    return `Error: Invalid line range [${startLine}, ${endLine}] in chunk. File has ${lines.length} lines.`;
                }
                const sliceOfLines = lines.slice(startLine - 1, endLine);
                const sliceText = sliceOfLines.join("\n");
                if (!sliceText.includes(targetContent)) {
                    return `Error: targetContent not found in specified line range [${startLine}, ${endLine}] for a chunk.`;
                }
                const replacedSlice = sliceText.replace(targetContent, replacementContent);
                lines = [
                    ...lines.slice(0, startLine - 1),
                    replacedSlice,
                    ...lines.slice(endLine),
                ];
            }
            const nextContent = lines.join("\n");
            const summary = buildEditSummary(content, nextContent, filePath);
            if (content === nextContent) {
                return summary;
            }
            await fs.writeFile(filePath, nextContent, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
                return `Warning: ${syntaxError}. File updated successfully with ${chunks.length} changes: ${filePath}\n${summary}`;
            }
            return `File updated successfully with ${chunks.length} changes: ${filePath}\n${summary}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error in multi-replace: ${message}`;
        }
    },
};
export const applyPatchTool = {
    name: "apply_patch",
    description: "Apply a unified diff or patch pattern to modify a file.",
    parameters: {
        type: "object",
        properties: {
            filePath: {
                type: "string",
                description: "Path to the file to patch",
            },
            patchContent: {
                type: "string",
                description: "Unified diff or search-replace format block",
            },
        },
        required: ["filePath", "patchContent"],
    },
    async execute(args, cwd, signal) {
        const filePath = path.resolve(cwd, args.filePath);
        const patchContent = args.patchContent;
        try {
            const originalContent = await fs.readFile(filePath, "utf-8");
            let content = originalContent;
            // If it looks like a unified diff
            if (patchContent.includes("@@ ") || patchContent.startsWith("---") || patchContent.startsWith("diff")) {
                const matchAt = (lines, start, target) => {
                    if (start + target.length > lines.length)
                        return false;
                    for (let idx = 0; idx < target.length; idx++) {
                        if (lines[start + idx].trimEnd() !== target[idx].trimEnd()) {
                            return false;
                        }
                    }
                    return true;
                };
                const lines = content.replace(/\r\n/g, "\n").split("\n");
                const patchLines = patchContent.split(/\r?\n/);
                let i = 0;
                while (i < patchLines.length) {
                    const line = patchLines[i];
                    if (line.startsWith("@@")) {
                        const match = /@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/.exec(line);
                        if (match) {
                            const oldStart = parseInt(match[1], 10) - 1;
                            i++;
                            const hunkOld = [];
                            const hunkNew = [];
                            while (i < patchLines.length &&
                                !patchLines[i].startsWith("@@") &&
                                !patchLines[i].startsWith("diff") &&
                                !patchLines[i].startsWith("---") &&
                                !patchLines[i].startsWith("+++")) {
                                const hLine = patchLines[i];
                                if (hLine.startsWith("-")) {
                                    hunkOld.push(hLine.slice(1));
                                }
                                else if (hLine.startsWith("+")) {
                                    hunkNew.push(hLine.slice(1));
                                }
                                else if (hLine.startsWith(" ")) {
                                    hunkOld.push(hLine.slice(1));
                                    hunkNew.push(hLine.slice(1));
                                }
                                else {
                                    hunkOld.push(hLine);
                                    hunkNew.push(hLine);
                                }
                                i++;
                            }
                            let foundIdx = -1;
                            const radius = 100;
                            const searchStart = Math.max(0, oldStart - radius);
                            const searchEnd = Math.min(lines.length - hunkOld.length + 1, oldStart + radius);
                            for (let j = oldStart; j >= searchStart; j--) {
                                if (matchAt(lines, j, hunkOld)) {
                                    foundIdx = j;
                                    break;
                                }
                            }
                            if (foundIdx === -1) {
                                for (let j = oldStart + 1; j < searchEnd; j++) {
                                    if (matchAt(lines, j, hunkOld)) {
                                        foundIdx = j;
                                        break;
                                    }
                                }
                            }
                            if (foundIdx === -1) {
                                return `Error: Could not find matching lines for patch hunk around line ${oldStart + 1}`;
                            }
                            lines.splice(foundIdx, hunkOld.length, ...hunkNew);
                            continue;
                        }
                    }
                    i++;
                }
                content = lines.join("\n");
            }
            else {
                const lines = patchContent.split(/\r?\n/);
                let targetLines = [];
                let replacementLines = [];
                let mode = "idle";
                for (const line of lines) {
                    if (line.startsWith("<<<<<<<")) {
                        mode = "search";
                        targetLines = [];
                    }
                    else if (line.startsWith("=======")) {
                        mode = "replace";
                        replacementLines = [];
                    }
                    else if (line.startsWith(">>>>>>>")) {
                        mode = "idle";
                        const oldStr = targetLines.join("\n");
                        const newStr = replacementLines.join("\n");
                        const normContent = normalizeForMatching(content);
                        const normOldStr = normalizeForMatching(oldStr);
                        if (normContent.includes(normOldStr)) {
                            const matchIndexInNorm = normContent.indexOf(normOldStr);
                            let normCharIdx = 0;
                            let origCharIdx = 0;
                            let matchOrigStart = -1;
                            let matchOrigEnd = -1;
                            while (origCharIdx < content.length && normCharIdx < normContent.length) {
                                if (normCharIdx === matchIndexInNorm) {
                                    matchOrigStart = origCharIdx;
                                }
                                if (normCharIdx === matchIndexInNorm + normOldStr.length) {
                                    matchOrigEnd = origCharIdx;
                                    break;
                                }
                                const cOrig = content[origCharIdx];
                                if (cOrig === "\r") {
                                    origCharIdx++;
                                    continue;
                                }
                                origCharIdx++;
                                normCharIdx++;
                            }
                            if (matchOrigStart !== -1 && matchOrigEnd !== -1) {
                                content = content.slice(0, matchOrigStart) + newStr + content.slice(matchOrigEnd);
                            }
                            else {
                                content = content.replace(oldStr, newStr);
                            }
                        }
                        else {
                            return `Error: Patch search block not found in target file: ${filePath}`;
                        }
                    }
                    else {
                        if (mode === "search") {
                            targetLines.push(line);
                        }
                        else if (mode === "replace") {
                            replacementLines.push(line);
                        }
                    }
                }
            }
            const summary = buildEditSummary(originalContent, content, filePath);
            if (originalContent === content) {
                return summary;
            }
            await fs.writeFile(filePath, content, "utf-8");
            const syntaxError = await verifySyntax(filePath);
            if (syntaxError) {
                return `Warning: ${syntaxError}. Applied patch to file: ${filePath}\n${summary}`;
            }
            return `Patch applied successfully to ${filePath}\n${summary}`;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return `Error applying patch: ${message}`;
        }
    },
};
//# sourceMappingURL=systemTools.js.map