import { execa } from "execa";
import { Tool } from "./types.js";
import { resolveFilePathFromArgs } from "./pathHelpers.js";
import { getLocalOfficeCliPath, isOfficeCliInstalledLocally } from "../androidSetup.js";

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

    // Split parameters to pass to execa
    // Basic shell splitting (handles spaces, does not handle complex nested quotes, but fits CLI execution needs)
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

    const bin = (await isOfficeCliInstalledLocally()) ? getLocalOfficeCliPath() : "officecli";

    // Attempt to execute officecli
    try {
      const { stdout, stderr } = await execa(bin, cleanParts, {
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
