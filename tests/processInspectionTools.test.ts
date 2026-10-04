import { describe, it, expect, afterEach } from "vitest";
import net from "net";
import http from "http";
import {
  inspectPortTool,
  freePortTool,
  findProcessTool,
  killProcessTool,
  inspectPort,
  freePort,
  isProtectedProcess,
  getProcessDetails,
} from "../src/core/tools/processInspectionTools.js";
import {
  isBlanketKillCommand,
  isDangerousCommand,
  isSystemDestructiveCommand,
  getToolDescription,
} from "../src/core/permissions.js";
import { getToolByName, allTools } from "../src/core/tools/index.js";
import {
  masterToolset,
  superagentToolset,
  subagentToolsets,
  chromeExtensionToolset,
} from "../src/core/tools/toolsets.js";
import {
  MASTER_AGENT_SYSTEM_PROMPT,
  SUPERAGENT_SYSTEM_PROMPT,
  SUBAGENT_SYSTEM_PROMPTS,
} from "../src/core/prompts.js";
import { getSystemPrompt } from "../src/core/config/base.js";
import { DEFAULT_MUSE_SYSTEM_PROMPT } from "../src/core/remoteAgent/protocol.js";

describe("Process Inspection & Targeted Port Management Suite", () => {
  let activeServers: Array<net.Server | http.Server> = [];

  afterEach(async () => {
    for (const server of activeServers) {
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      } catch {}
    }
    activeServers = [];
  });

  describe("Protected Process Guardrails", () => {
    it("should protect system kernel and idle PIDs", () => {
      expect(isProtectedProcess("System", 4)).toBe(true);
      expect(isProtectedProcess("System Idle Process", 0)).toBe(true);
    });

    it("should protect current Superagent host process and parent", () => {
      expect(isProtectedProcess("node.exe", process.pid)).toBe(true);
      if (process.ppid) {
        expect(isProtectedProcess("cmd.exe", process.ppid)).toBe(true);
      }
    });

    it("should protect critical operating system processes by name", () => {
      expect(isProtectedProcess("csrss.exe")).toBe(true);
      expect(isProtectedProcess("lsass.exe")).toBe(true);
      expect(isProtectedProcess("services.exe")).toBe(true);
      expect(isProtectedProcess("smss.exe")).toBe(true);
      expect(isProtectedProcess("explorer.exe")).toBe(true);
      expect(isProtectedProcess("systemd")).toBe(true);
      expect(isProtectedProcess("launchd")).toBe(true);
    });

    it("should not mark normal development processes as protected", () => {
      expect(isProtectedProcess("bun.exe", 99999)).toBe(false);
      expect(isProtectedProcess("node.exe", 99999)).toBe(false);
      expect(isProtectedProcess("vite", 99999)).toBe(false);
    });
  });

  describe("Blanket Kill Detection & Permissions Gate", () => {
    it("should detect Windows blanket taskkill commands", () => {
      const res1 = isBlanketKillCommand("taskkill /F /IM bun.exe");
      expect(res1.isBlanketKill).toBe(true);
      expect(res1.reason).toContain("Blanket process termination");

      const res2 = isBlanketKillCommand("taskkill //F //IM node.exe");
      expect(res2.isBlanketKill).toBe(true);

      const res3 = isBlanketKillCommand("taskkill -f -im python.exe");
      expect(res3.isBlanketKill).toBe(true);
    });

    it("should detect POSIX blanket killall and pkill commands", () => {
      expect(isBlanketKillCommand("killall node").isBlanketKill).toBe(true);
      expect(isBlanketKillCommand("killall -9 bun").isBlanketKill).toBe(true);
      expect(isBlanketKillCommand("pkill -f bun").isBlanketKill).toBe(true);
      expect(isBlanketKillCommand("pkill -9 node").isBlanketKill).toBe(true);
    });

    it("should detect PowerShell Stop-Process blanket commands", () => {
      expect(isBlanketKillCommand("Stop-Process -Name bun -Force").isBlanketKill).toBe(true);
      expect(isBlanketKillCommand("Stop-Process -ProcessName node").isBlanketKill).toBe(true);
    });

    it("should allow targeted single-PID terminations", () => {
      expect(isBlanketKillCommand("taskkill /F /PID 12345").isBlanketKill).toBe(false);
      expect(isBlanketKillCommand("kill -9 12345").isBlanketKill).toBe(false);
      expect(isBlanketKillCommand("Stop-Process -Id 12345").isBlanketKill).toBe(false);
      expect(isBlanketKillCommand("git status").isBlanketKill).toBe(false);
    });

    it("should categorize blanket kills as dangerous and system destructive", () => {
      const cmd = "taskkill /F /IM bun.exe";
      expect(isDangerousCommand(cmd)).toBe(true);
      expect(isSystemDestructiveCommand(cmd)).toBe(true);
    });
  });

  describe("inspect_port Tool", () => {
    it("should reject invalid port numbers", async () => {
      const res1 = await inspectPortTool.execute({ port: 0 }, process.cwd());
      expect(res1).toContain("Error: Invalid port number");

      const res2 = await inspectPortTool.execute({ port: 99999 }, process.cwd());
      expect(res2).toContain("Error: Invalid port number");

      const res3 = await inspectPortTool.execute({ port: "invalid" }, process.cwd());
      expect(res3).toContain("Error: Invalid port number");
    });

    it("should report a free port as FREE", async () => {
      // Find an ephemeral unused port
      const freePortNum = 49152 + Math.floor(Math.random() * 1000);
      const res = await inspectPortTool.execute({ port: freePortNum }, process.cwd());
      expect(res).toContain(`Port ${freePortNum} is FREE`);
    });

    it("should inspect a live listening port and identify PID", async () => {
      const server = http.createServer((_, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      activeServers.push(server);

      const address = server.address() as net.AddressInfo;
      const port = address.port;

      const inspection = await inspectPort(port);
      expect(inspection.status).toBe("listening");
      expect(inspection.processes.length).toBeGreaterThan(0);
      expect(inspection.processes[0].pid).toBe(process.pid);

      const toolOutput = await inspectPortTool.execute({ port }, process.cwd());
      expect(toolOutput).toContain(`Port ${port} is currently OCCUPIED`);
      expect(toolOutput).toContain(String(process.pid));
      expect(toolOutput).toContain("free_port");
    });
  });

  describe("free_port Tool", () => {
    it("should return already free if port has no process", async () => {
      const unusedPort = 48200 + Math.floor(Math.random() * 500);
      const res = await freePortTool.execute({ port: unusedPort }, process.cwd());
      expect(res).toContain(`Port ${unusedPort} is already free`);
    });

    it("should refuse to kill protected process holding port", async () => {
      // Current process is protected
      const server = http.createServer((_, res) => res.end("ok"));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      activeServers.push(server);

      const address = server.address() as net.AddressInfo;
      const port = address.port;

      const result = await freePort(port);
      expect(result.success).toBe(false);
      expect(result.message).toContain("protected process");
    });
  });

  describe("find_process Tool", () => {
    it("should require query parameter", async () => {
      const res = await findProcessTool.execute({ query: "" }, process.cwd());
      expect(res).toContain("Error: Missing required parameter 'query'");
    });

    it("should find processes matching query", async () => {
      const res = await findProcessTool.execute({ query: "node" }, process.cwd());
      expect(res).toContain("active process(es) matching");
    });
  });

  describe("kill_process Tool", () => {
    it("should reject invalid PID", async () => {
      const res = await killProcessTool.execute({ pid: -1 }, process.cwd());
      expect(res).toContain("Error: Invalid process ID");
    });

    it("should refuse to kill protected system PID", async () => {
      const res = await killProcessTool.execute({ pid: 4 }, process.cwd());
      expect(res).toContain("Cannot terminate protected process");
    });
  });

  describe("Tool Registration & Tier Toolset Availability", () => {
    it("should resolve inspect_port and free_port by exact and alias names", () => {
      expect(getToolByName("inspect_port")?.name).toBe("inspect_port");
      expect(getToolByName("check_port")?.name).toBe("inspect_port");
      expect(getToolByName("port_inspect")?.name).toBe("inspect_port");

      expect(getToolByName("free_port")?.name).toBe("free_port");
      expect(getToolByName("kill_port")?.name).toBe("free_port");
      expect(getToolByName("release_port")?.name).toBe("free_port");

      expect(getToolByName("find_process")?.name).toBe("find_process");
      expect(getToolByName("search_process")?.name).toBe("find_process");

      expect(getToolByName("kill_process")?.name).toBe("kill_process");
      expect(getToolByName("terminate_process")?.name).toBe("kill_process");
    });

    it("should include inspection tools in masterToolset", () => {
      const masterToolNames = masterToolset.map((t) => t.name);
      expect(masterToolNames).toContain("inspect_port");
      expect(masterToolNames).toContain("find_process");
    });

    it("should include all 4 process/port tools in superagentToolset and chromeExtensionToolset", () => {
      const superagentToolNames = superagentToolset.map((t) => t.name);
      expect(superagentToolNames).toContain("inspect_port");
      expect(superagentToolNames).toContain("free_port");
      expect(superagentToolNames).toContain("find_process");
      expect(superagentToolNames).toContain("kill_process");

      const chromeToolNames = chromeExtensionToolset.map((t) => t.name);
      expect(chromeToolNames).toContain("inspect_port");
      expect(chromeToolNames).toContain("free_port");
      expect(chromeToolNames).toContain("find_process");
      expect(chromeToolNames).toContain("kill_process");
    });

    it("should include process/port tools in coder and software-tester subagent toolsets", () => {
      const coderToolNames = subagentToolsets.coder.map((t) => t.name);
      expect(coderToolNames).toContain("inspect_port");
      expect(coderToolNames).toContain("free_port");
      expect(coderToolNames).toContain("find_process");
      expect(coderToolNames).toContain("kill_process");

      const testerToolNames = subagentToolsets["software-tester"].map((t) => t.name);
      expect(testerToolNames).toContain("inspect_port");
      expect(testerToolNames).toContain("free_port");
      expect(testerToolNames).toContain("find_process");
      expect(testerToolNames).toContain("kill_process");
    });

    it("should generate friendly tool descriptions in getToolDescription", () => {
      expect(getToolDescription({ name: "inspect_port", args: { port: 7001 } })).toBe(
        "Inspecting TCP port: 7001"
      );
      expect(getToolDescription({ name: "free_port", args: { port: 7101 } })).toBe(
        "Freeing process holding TCP port: 7101"
      );
      expect(getToolDescription({ name: "find_process", args: { query: "bun" } })).toBe(
        "Searching active processes for: bun"
      );
      expect(getToolDescription({ name: "kill_process", args: { pid: 21152 } })).toBe(
        "Terminating process PID: 21152"
      );
    });
  });

  describe("Prompt Alignment & Process Safety Guardrails", () => {
    it("should include blanket kill ban and port diagnosis in MASTER_AGENT_SYSTEM_PROMPT", () => {
      expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("PROCESS_AND_PORT_SAFETY");
      expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("inspect_port");
      expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("free_port");
      expect(MASTER_AGENT_SYSTEM_PROMPT).toContain("Blanket process termination");
    });

    it("should include blanket kill ban and port diagnosis in SUPERAGENT_SYSTEM_PROMPT", () => {
      const saPrompt = SUPERAGENT_SYSTEM_PROMPT("coder", "feat/test", "/tmp/wt");
      expect(saPrompt).toContain("PROCESS_AND_PORT_SAFETY");
      expect(saPrompt).toContain("inspect_port");
      expect(saPrompt).toContain("free_port");
      expect(saPrompt).toContain("Blanket process termination");
    });

    it("should include process protection and port safety in coder and software-tester subagent prompts", () => {
      expect(SUBAGENT_SYSTEM_PROMPTS.coder).toContain("PROCESS_AND_PORT_SAFETY");
      expect(SUBAGENT_SYSTEM_PROMPTS.coder).toContain("inspect_port");
      expect(SUBAGENT_SYSTEM_PROMPTS["software-tester"]).toContain("PROCESS_AND_PORT_SAFETY");
      expect(SUBAGENT_SYSTEM_PROMPTS["software-tester"]).toContain("inspect_port");
    });

    it("should include blanket kill ban and process/port tools in base single-agent getSystemPrompt()", () => {
      const basePrompt = getSystemPrompt();
      expect(basePrompt).toContain("PROCESS_AND_PORT_SAFETY");
      expect(basePrompt).toContain("inspect_port");
      expect(basePrompt).toContain("free_port");
      expect(basePrompt).toContain("Blanket process termination");
    });

    it("should include blanket kill prohibition and inspect_port guidance in DEFAULT_MUSE_SYSTEM_PROMPT", () => {
      expect(DEFAULT_MUSE_SYSTEM_PROMPT).toContain("inspect_port");
      expect(DEFAULT_MUSE_SYSTEM_PROMPT).toContain("free_port");
      expect(DEFAULT_MUSE_SYSTEM_PROMPT).toContain("FORBIDDEN: mass process killing");
    });
  });
});

