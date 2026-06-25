import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Box, Text } from "ink";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let version = "1.1.0";
try {
    const pkgPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    version = pkg.version;
}
catch (e) {
    // fallback
}
function isGitRepo() {
    try {
        execSync("git rev-parse --is-inside-work-tree", {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return true;
    }
    catch {
        return false;
    }
}
export function Banner() {
    const hasGit = isGitRepo();
    return (_jsxs(Box, { flexDirection: "column", paddingX: 1, marginY: 1, children: [_jsxs(Box, { flexDirection: "row", alignItems: "center", children: [_jsxs(Box, { flexDirection: "column", marginRight: 3, alignItems: "center", children: [_jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", bold: true, children: " \u25E5\u2588\u25E3  \u25B2  \u25E2\u2588\u25E4 " }) }), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", bold: true, children: "  \u25E5\u2588\u2588 \u2588 \u2588\u2588\u25E4  " }) }), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", bold: true, children: "   \u25E5\u2588\u2588\u2588\u2588\u2588\u25E4   " }) }), _jsx(Box, { flexDirection: "row", children: _jsx(Text, { color: "yellow", bold: true, children: "     \u25E5\u2588\u25E4     " }) })] }), _jsxs(Box, { flexDirection: "column", justifyContent: "center", children: [_jsxs(Box, { flexDirection: "row", marginBottom: 1, alignItems: "center", children: [_jsx(Text, { color: "red", bold: true, children: "S U P E R" }), _jsx(Text, { color: "white", bold: true, children: "A G E N T" }), _jsx(Text, { color: "gray", children: " \u2502 " }), _jsxs(Text, { color: "yellow", bold: true, children: ["COGNITIVE SYSTEM v", version] }), _jsx(Text, { color: "gray", children: " \u2502 " }), _jsx(Text, { color: "green", bold: true, children: "\u25CF READY" })] }), _jsxs(Box, { flexDirection: "row", children: [_jsx(Text, { dimColor: true, children: "Type your query or " }), _jsx(Text, { bold: true, color: "cyan", children: "/help" }), _jsx(Text, { dimColor: true, children: " to explore commands" })] })] })] }), !hasGit && (_jsxs(Box, { marginTop: 1, paddingX: 1, children: [_jsx(Text, { color: "yellow", children: "\u26A0 " }), _jsx(Text, { dimColor: true, children: "Git not detected in this project. Checkpoints won't capture code state." }), _jsx(Text, { dimColor: true, children: " Run " }), _jsx(Text, { bold: true, color: "cyan", children: "git init" }), _jsx(Text, { dimColor: true, children: " or " }), _jsx(Text, { bold: true, color: "cyan", children: "/init" }), _jsx(Text, { dimColor: true, children: " to enable full checkpoint features." })] }))] }));
}
//# sourceMappingURL=banner.js.map