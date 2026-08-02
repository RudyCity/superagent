import { execa } from "execa";
import { Tool } from "./types.js";
import { workspaceMode } from "../ssh/workspaceMode.js";

export const officeCliTool: Tool = {
  name: "office_cli",
  description: "Execute officecli commands to create, modify, inspect, or convert Word (.docx), Excel (.xlsx), and PowerPoint (.pptx) documents.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The sub-command to execute (e.g., 'help', 'view text report.docx', 'create presentation.pptx', 'set sheet.xlsx /Sheet1/A1 --prop value=42')",
      },
    },
    required: ["command"],
  },
  async execute(args, cwd, signal) {
    const rawCommand = args.command as string;
    if (!rawCommand || typeof rawCommand !== "string" || rawCommand.trim() === "") {
      return "Error: Missing required parameter 'command'. Provide the officecli sub-command to execute.";
    }

    // Split parameters to pass to execa
    const parts = rawCommand.match(/(?:[^\s"']+|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')+/g) || [];
    const cleanParts = parts.map(part => {
      if ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'"))) {
        return part.slice(1, -1);
      }
      return part;
    });

    if (cleanParts.length === 0) {
      return "Error: Empty command parameter";
    }

    const androidSetup = await import("../androidSetup.js");
    const localBin = (await androidSetup.isOfficeCliInstalledLocally()) ? androidSetup.getLocalOfficeCliPath() : "officecli";

    // SSH routing: run officecli on remote host (where the files live).
    if (workspaceMode.isSsh()) {
      try {
        const { sshProxy } = await import("../ssh/sshProxy.js");
        const remoteCwd = (workspaceMode.getConfig()?.remoteCwd || cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
        const extraPaths = workspaceMode.getConfig()?.additionalAllowedPaths ?? [];
        // Boundary enforcement: scan args for absolute paths that escape remoteCwd.
        const normalizedBase = "/" + remoteCwd.split("/").filter((p) => p && p !== ".").join("/");
        const isInsideRemote = (posix: string) => {
          if (!normalizedBase || normalizedBase === "/") return true;
          if (posix === normalizedBase || posix.startsWith(normalizedBase + "/")) return true;
          return extraPaths.some(ep => {
            const cleanEp = ep.replace(/\/+$/, "");
            return cleanEp && (posix === cleanEp || posix.startsWith(cleanEp + "/"));
          });
        };
        for (const token of cleanParts) {
          if (typeof token === "string" && token.includes("/")) {
            const posix = token.replace(/\\/g, "/");
            if (posix.startsWith("/") && !isInsideRemote(posix)) {
              return `Error: Path "${token}" violates SSH workspace boundary. Use \`/ssh expand ${posix.split("/").slice(0, 3).join("/")}\` to allow access, or move the file into "${remoteCwd}".`;
            }
          }
        }
        const escaped = cleanParts.map((p) => /^[A-Za-z0-9_./:@\-]+$/.test(p) ? p : `"${p.replace(/"/g, '\\"')}"`).join(" ");
        const res = await sshProxy.exec(`officecli ${escaped}`, remoteCwd, 600000, signal);
        if (res.exitCode !== 0) {
          if (/command not found|not found.*officecli/i.test(res.stderr || "")) {
            return `Error: 'officecli' command not found on remote SSH host. Install it via:\n  curl -fsSL https://d.officecli.ai/install.sh | bash`;
          }
          return res.stderr || res.stdout || `Remote officecli failed with exit ${res.exitCode}`;
        }
        return res.stdout || res.stderr || "Command executed successfully with no output.";
      } catch (err: any) {
        return `Error executing officecli on remote SSH host: ${err?.message || err}`;
      }
    }

    try {
      const { stdout, stderr } = await execa(localBin, cleanParts, {
        cwd,
        reject: false,
        signal,
      });

      if (stderr && !stdout) {
        return stderr;
      }
      return stdout || stderr || "Command executed successfully with no output.";
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return `Error: 'officecli' command not found. Please install it using:\nWindows (PowerShell):\n  irm https://d.officecli.ai/install.ps1 | iex\nmacOS / Linux:\n  curl -fsSL https://d.officecli.ai/install.sh | bash`;
      }
      return `Error executing officecli: ${error.message}`;
    }
  }
};
