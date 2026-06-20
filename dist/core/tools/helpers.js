import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { execSync } from "child_process";
import ts from "typescript";
let cachedShell = null;
export function resolveWindowsShell() {
    if (cachedShell)
        return cachedShell;
    if (process.platform !== "win32") {
        cachedShell = { shellPath: "bash", isBash: true };
        return cachedShell;
    }
    // Common Git Bash locations
    const commonPaths = [
        "C:\\Program Files\\Git\\bin\\bash.exe",
        "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
        "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ];
    // Try common installation directories
    for (const p of commonPaths) {
        if (fsSync.existsSync(p)) {
            cachedShell = { shellPath: p, isBash: true };
            return cachedShell;
        }
    }
    // Try checking PATH for bash.exe using 'where'
    try {
        const whereBash = execSync("where bash", { stdio: [] }).toString().trim().split(/\r?\n/)[0];
        if (whereBash && fsSync.existsSync(whereBash)) {
            cachedShell = { shellPath: whereBash, isBash: true };
            return cachedShell;
        }
    }
    catch {
        // Ignore error if 'where bash' fails
    }
    // Fallback to PowerShell
    cachedShell = { shellPath: "powershell.exe", isBash: false };
    return cachedShell;
}
export function formatCommandForPowerShell(command) {
    const parts = [];
    let currentPart = "";
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let i = 0;
    while (i < command.length) {
        const char = command[i];
        if (char === '"' && !inSingleQuote) {
            inDoubleQuote = !inDoubleQuote;
            currentPart += char;
            i++;
        }
        else if (char === "'" && !inDoubleQuote) {
            inSingleQuote = !inSingleQuote;
            currentPart += char;
            i++;
        }
        else if (!inDoubleQuote && !inSingleQuote && char === '&' && command[i + 1] === '&') {
            parts.push(currentPart.trim());
            currentPart = "";
            i += 2;
        }
        else {
            currentPart += char;
            i++;
        }
    }
    parts.push(currentPart.trim());
    if (parts.length <= 1) {
        return command;
    }
    let result = parts[0];
    for (let j = 1; j < parts.length; j++) {
        result += `; if ($?) { ${parts[j]}`;
    }
    result += " }".repeat(parts.length - 1);
    return result;
}
export function normalizeForMatching(str) {
    return str
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.trimEnd())
        .join("\n");
}
export async function verifySyntax(filePath) {
    const ext = path.extname(filePath);
    if (ext !== ".ts" && ext !== ".tsx" && ext !== ".js" && ext !== ".jsx") {
        return null;
    }
    try {
        const code = await fs.readFile(filePath, "utf-8");
        const sourceKind = ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        const sourceFile = ts.createSourceFile(filePath, code, ts.ScriptTarget.Latest, true, sourceKind);
        const compilerHost = ts.createCompilerHost({
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ESNext,
            noEmit: true,
        });
        compilerHost.getSourceFile = (requestedFileName, languageVersion) => {
            if (path.resolve(requestedFileName) === path.resolve(filePath)) {
                return sourceFile;
            }
            return ts.createCompilerHost({}).getSourceFile(requestedFileName, languageVersion);
        };
        compilerHost.writeFile = () => { };
        const program = ts.createProgram([filePath], { noEmit: true, jsx: ts.JsxEmit.React }, compilerHost);
        const diagnostics = program.getSyntacticDiagnostics(sourceFile);
        if (diagnostics.length === 0) {
            return null;
        }
        const diagnostic = diagnostics[0];
        const position = diagnostic.start ?? 0;
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(position);
        const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        return `Syntax check failed: ${message} at ${path.basename(filePath)}:${line + 1}:${character + 1}`;
    }
    catch {
        return null;
    }
}
export function truncateOutput(output, maxLines = 100) {
    const lines = output.split(/\r?\n/);
    if (lines.length > maxLines) {
        return lines.slice(0, maxLines).join("\n") + `\n\n... (output truncated, showing ${maxLines} of ${lines.length} lines)`;
    }
    return output;
}
/**
 * Normalize backslash paths inside git commands to forward slashes.
 * Prevents Windows-style `feat\timer-service` being interpreted as
 * `feat<TAB>imer-service` by Git/Bash.
 *
 * Only transforms arguments that follow git subcommands (checkout, diff,
 * log, branch, worktree, merge, stash, etc.) — leaves the rest untouched.
 */
export function normalizeGitPaths(command) {
    // Match git subcommands that take branch/path arguments
    const gitSubcommands = /\b(git)\s+(checkout|diff|log|branch|worktree|merge|stash|show|reset|restore|add|cherry-pick|rebase)\b/;
    if (!gitSubcommands.test(command)) {
        return command;
    }
    // Replace backslash path separators in tokens that look like branch names
    // or file paths following git subcommands. Avoids modifying string literals.
    return command.replace(/(?<=git\s+(?:checkout|diff|log|branch|worktree|merge|stash|show|reset|restore|add|cherry-pick|rebase)\s+)([^\s;&|]+)/g, (match) => match.replace(/\\/g, "/"));
}
export function detectInteractivePrompt(text) {
    // Patterns must be specific enough to avoid matching TypeScript/source code.
    // Each pattern targets typical CLI prompts, not code declarations.
    const patterns = [
        /\[y\/n\]\s*$/im, // [y/n] at end of line
        /\(y\/n\)\s*$/im, // (y/n) at end of line
        /(?:^|\n)\s*(?:please\s+)?confirm\s*\?/im, // "confirm?" as standalone prompt
        /(?:^|\n)\s*proceed\s*\?/im, // "proceed?" as standalone prompt
        /(?:^|\n)\s*enter\s+password\s*:/im, // "Enter password:" prompt
        /(?:^|\n)\s*select\s+an?\s+option/i, // "Select an option"
        /(?:^|\n)\s*(?:please\s+)?(?:choose|pick)\s+(?:one|an?\s+option)/i,
        /(?:^|\n)\s*password\s*:\s*$/im, // "password:" at end of line (not in code)
        /(?:^|\n)\s*passphrase\s+for\s+/im, // SSH passphrase prompt
        /(?:^|\n)\s*username\s*:\s*$/im, // "username:" at end of line
        /(?:^|\n)\s*(?:continue|accept)\s*\[y\/n/i, // "Continue [y/n"
        /(?:^|\n)\s*do\s+you\s+(?:want|wish)\s+to\s+/i, // "Do you want to..."
        /(?:^|\n)\s*overwrite\s+\(y\/n\)/i, // "Overwrite (y/n)"
    ];
    for (const pattern of patterns) {
        if (pattern.test(text)) {
            return `Warning: Interactive prompt detected ("${text.trim().slice(-30)}"). The command may hang. Use run_background_process and manage_background_process 'send_input' to interact.`;
        }
    }
    return null;
}
//# sourceMappingURL=helpers.js.map