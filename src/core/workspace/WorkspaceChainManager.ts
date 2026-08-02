/**
 * WorkspaceChainManager.ts — Runtime manager for active workspace chains.
 *
 * Maintains the active chain state, manages SSH connections for chain nodes,
 * and provides cross-workspace execution capabilities.
 */

import { Client } from "ssh2";
import SFTPClient from "ssh2-sftp-client";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import {
  WorkspaceChain,
  WorkspaceNode,
  CrossWorkspaceResult,
  formatChainTopology,
} from "./WorkspaceChainTypes.js";
import {
  getWorkspaceChain,
  getActiveChainId,
  setActiveChainId,
} from "./WorkspaceChainConfig.js";
import { sshLogger } from "../ssh/sshLogger.js";
import { workspaceMode } from "../ssh/workspaceMode.js";
import { resolveHostAlias, findDefaultPrivateKey } from "../ssh/sshConfig.js";

/** SSH connection wrapper for a chain node */
interface ChainSshConnection {
  nodeId: string;
  client: Client;
  sftp: SFTPClient;
  config: WorkspaceNode["sshConfig"];
}

class WorkspaceChainManagerClass {
  private activeChain: WorkspaceChain | null = null;
  private activeNodeId: string | null = null;
  private sshConnections: Map<string, ChainSshConnection> = new Map();
  private connectingPromises: Map<string, Promise<void>> = new Map();

  /** Load the active chain from config */
  public loadActiveChain(currentWorkspacePath?: string): WorkspaceChain | null {
    const chainId = getActiveChainId(currentWorkspacePath);
    if (!chainId) {
      this.activeChain = null;
      this.activeNodeId = null;
      return null;
    }
    const chain = getWorkspaceChain(chainId);
    if (!chain) {
      this.activeChain = null;
      this.activeNodeId = null;
      return null;
    }
    this.activeChain = chain;
    this.activeNodeId = chain.primaryNodeId;
    return chain;
  }

  /** Get the currently active chain */
  public getActiveChain(currentWorkspacePath?: string): WorkspaceChain | null {
    return this.loadActiveChain(currentWorkspacePath);
  }

  /** Get the active node ID */
  public getActiveNodeId(): string | null {
    return this.activeNodeId;
  }

  /** Set the active node within the current chain */
  public setActiveNode(nodeId: string): boolean {
    if (!this.activeChain) return false;
    const node = this.activeChain.nodes.find(n => n.id === nodeId);
    if (!node) return false;
    this.activeNodeId = nodeId;
    if (node.type === "ssh" && node.sshConfig) {
      workspaceMode.setSshMode(node.sshConfig);
    } else {
      workspaceMode.setLocalMode();
    }
    return true;
  }

  /** Activate a chain by ID */
  public async activateChain(chainId: string, currentWorkspacePath?: string): Promise<WorkspaceChain> {
    const chain = getWorkspaceChain(chainId, currentWorkspacePath);
    if (!chain) {
      throw new Error(`Workspace chain not found: ${chainId}`);
    }
    await this.disconnectAll();
    this.activeChain = chain;
    this.activeNodeId = chain.primaryNodeId;
    setActiveChainId(chainId);
    
    const primaryNode = chain.nodes.find(n => n.id === chain.primaryNodeId);
    if (primaryNode && primaryNode.type === "ssh" && primaryNode.sshConfig) {
      workspaceMode.setSshMode(primaryNode.sshConfig);
    } else {
      workspaceMode.setLocalMode();
    }
    return chain;
  }

  /** Deactivate the current chain */
  public async deactivateChain(): Promise<void> {
    await this.disconnectAll();
    this.activeChain = null;
    this.activeNodeId = null;
    setActiveChainId(null);
    workspaceMode.setLocalMode();
  }

  /** Get a node by ID from the active chain */
  public getNode(nodeId: string): WorkspaceNode | null {
    if (!this.activeChain) return null;
    return this.activeChain.nodes.find(n => n.id === nodeId) || null;
  }

  /** Get the active node */
  public getActiveNode(): WorkspaceNode | null {
    if (!this.activeNodeId) return null;
    return this.getNode(this.activeNodeId);
  }

  /** Get topology string for prompt injection */
  public getTopologyString(): string {
    if (!this.activeChain) return "";
    return formatChainTopology(this.activeChain, this.activeNodeId || undefined);
  }

  /** Check if a chain is active */
  public isChainActive(currentWorkspacePath?: string): boolean {
    return this.getActiveChain(currentWorkspacePath) !== null;
  }

  /** Connect to an SSH node in the chain with exponential backoff retry */
  public async connectSshNode(nodeId: string, maxRetries = 3, initialBackoffMs = 1000): Promise<void> {
    if (this.sshConnections.has(nodeId)) return;
    if (this.connectingPromises.has(nodeId)) {
      return this.connectingPromises.get(nodeId)!;
    }

    const node = this.getNode(nodeId);
    if (!node || node.type !== "ssh" || !node.sshConfig) {
      throw new Error(`Node ${nodeId} is not an SSH node or missing SSH config`);
    }

    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const promise = this._doConnectSsh(nodeId, node.sshConfig).finally(() => {
          this.connectingPromises.delete(nodeId);
        });
        this.connectingPromises.set(nodeId, promise);
        await promise;
        return;
      } catch (err: any) {
        lastErr = err;
        this.sshConnections.delete(nodeId);
        if (attempt < maxRetries - 1) {
          const backoff = initialBackoffMs * Math.pow(2, attempt);
          sshLogger.warn("chain.connect", `retrying SSH connection for node ${nodeId} in ${backoff}ms (attempt ${attempt + 1}/${maxRetries}): ${err.message}`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw lastErr || new Error(`Failed to connect to SSH node ${nodeId} after ${maxRetries} attempts`);
  }

  /** Internal SSH connection logic */
  private async _doConnectSsh(nodeId: string, config: NonNullable<WorkspaceNode["sshConfig"]>): Promise<void> {
    // SSH config file support: resolve host alias from ~/.ssh/config
    const alias = resolveHostAlias(config.host);
    if (alias) {
      if (alias.hostname) config.host = alias.hostname;
      if (alias.user && config.username === "root") config.username = alias.user;
      if (alias.identityFile && !config.privateKeyPath) config.privateKeyPath = alias.identityFile;
      if (alias.proxyJump && !config.proxyJump) config.proxyJump = alias.proxyJump;
      if (alias.compression !== undefined && config.compression === undefined) config.compression = alias.compression;
      if (alias.forwardAgent !== undefined && config.agentForward === undefined) config.agentForward = alias.forwardAgent;
      sshLogger.info("chain.ssh_config", `resolved host alias for node ${nodeId} from ~/.ssh/config`);
    }

    sshLogger.info("chain.connect", `connecting to SSH node ${nodeId}`, {
      host: config.host,
      user: config.username,
      remoteCwd: config.remoteCwd,
    });

    const privateKey = config.privateKeyPath
      ? fs.readFileSync(config.privateKeyPath)
      : findDefaultPrivateKey();

    const connectConfig: any = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      readyTimeout: config.readyTimeout || 15000,
    };

    if (config.compression) {
      connectConfig.compress = true;
      sshLogger.info("chain.connect", `SSH compression enabled for node ${nodeId}`);
    }
    if (config.agentForward) {
      connectConfig.agentForward = true;
      sshLogger.info("chain.connect", `SSH agent forwarding enabled for node ${nodeId}`);
    }

    if (config.password) {
      connectConfig.password = config.password;
    } else if (privateKey) {
      connectConfig.privateKey = privateKey;
    }

    // Host key verification (TOFU)
    const knownHostsPath = path.join(os.homedir(), ".superagent-r", "known_hosts");
    let knownFingerprint: string | undefined;
    try {
      const content = fs.readFileSync(knownHostsPath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const [host, fingerprint] = trimmed.split(/\s+/);
        if (host === config.host && fingerprint) {
          knownFingerprint = fingerprint;
          break;
        }
      }
    } catch {}

    if (knownFingerprint) {
      connectConfig.hostVerifier = (key: Buffer): boolean => {
        const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
        return fingerprint === knownFingerprint;
      };
    } else {
      connectConfig.hostVerifier = (key: Buffer): boolean => {
        const fingerprint = crypto.createHash("sha256").update(key).digest("hex");
        try {
          const dir = path.dirname(knownHostsPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(knownHostsPath, `${config.host} ${fingerprint}\n`, "utf-8");
        } catch {}
        return true;
      };
    }

    const sftp = new SFTPClient();
    try {
      await sftp.connect(connectConfig);
    } catch (err: any) {
      const hint = !config.privateKeyPath && !config.password
        ? ` — no privateKeyPath or password set. Set 'privateKeyPath' in the SSH node config or place a key in ~/.ssh/`
        : "";
      throw new Error(`SSH connection failed to ${config.host}:${config.port} — ${err.message}${hint}`);
    }

    const client = (sftp as any).client as Client;

    this.sshConnections.set(nodeId, {
      nodeId,
      client,
      sftp,
      config,
    });

    sshLogger.info("chain.connect", `SSH node ${nodeId} connected (single TCP session)`, { host: config.host });
  }

  /** Get SSH connection for a node */
  public getSshConnection(nodeId: string): ChainSshConnection | null {
    return this.sshConnections.get(nodeId) || null;
  }

  /** Secure path normalization and boundary check */
  private normalizeAndVerifyPath(node: WorkspaceNode, filePath: string): string {
    const isSsh = node.type === "ssh";
    const raw = typeof filePath === "string" && filePath.length > 0 ? filePath : ".";
    const clean = raw.replace(/\\/g, "/");

    if (isSsh) {
      const base = node.sshConfig?.remoteCwd || "/";
      const posixBase = base.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
      let resolved: string;
      if (clean.startsWith("/")) {
        resolved = clean;
      } else {
        resolved = posixBase === "/" ? `/${clean}` : `${posixBase}/${clean}`;
      }

      const parts = resolved.split("/").reduce<string[]>((acc, seg) => {
        if (seg === "..") {
          acc.pop();
        } else if (seg !== "" && seg !== ".") {
          acc.push(seg);
        }
        return acc;
      }, []);
      const normalized = "/" + parts.join("/");

      const baseParts = posixBase.split("/").filter((p) => p !== "" && p !== ".");
      const normalizedBase = "/" + baseParts.join("/");

      if (
        normalizedBase !== "/" &&
        normalized !== normalizedBase &&
        !normalized.startsWith(normalizedBase + "/")
      ) {
        throw new Error(`Access denied: Path "${filePath}" escapes remote workspace boundary "${posixBase}"`);
      }
      return normalized;
    } else {
      const base = node.path || process.cwd();
      const resolved = path.resolve(base, filePath);
      const cleanBase = path.resolve(base);
      if (resolved !== cleanBase && !resolved.startsWith(cleanBase + path.sep)) {
        throw new Error(`Access denied: Path "${filePath}" escapes local workspace boundary "${base}"`);
      }
      return resolved;
    }
  }

  /** Execute a command on a specific node (local or SSH) */
  public async execOnNode(
    nodeId: string,
    command: string,
    cwd?: string,
    timeoutMs: number = 600000
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    if (node.type === "local") {
      const { execa } = await import("execa");
      const workingDir = this.normalizeAndVerifyPath(node, cwd || ".");
      const result = await execa(command, {
        cwd: workingDir,
        shell: true,
        timeout: timeoutMs,
        reject: false,
      });
      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        exitCode: result.exitCode ?? 0,
      };
    }

    // SSH execution
    if (node.type === "ssh") {
      let conn = this.getSshConnection(nodeId);
      if (!conn) {
        await this.connectSshNode(nodeId);
        conn = this.getSshConnection(nodeId);
      }
      if (!conn) {
        throw new Error(`Failed to establish SSH connection to node ${nodeId}`);
      }

      const remoteCwd = this.normalizeAndVerifyPath(node, cwd || ".");
      const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const fullCommand = `cd ${esc(remoteCwd)} && ${command}`;

      let sshStream: any = null;

      const execPromise = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
        conn!.client.exec(fullCommand, (err, stream) => {
          if (err) {
            reject(err);
            return;
          }
          sshStream = stream;
          let stdout = "";
          let stderr = "";
          let settled = false;

          stream.on("data", (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
          stream.on("close", (code: number | null) => {
            if (!settled) {
              settled = true;
              resolve({ stdout, stderr, exitCode: code ?? 0 });
            }
          });
          stream.on("error", (streamErr: Error) => {
            if (!settled) {
              settled = true;
              reject(streamErr);
            }
          });
        });
      });

      if (timeoutMs <= 0) return execPromise;

      let timer: NodeJS.Timeout;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (sshStream) {
            try { sshStream.close(); } catch {}
          }
          reject(new Error(`SSH execution timed out after ${timeoutMs}ms on node ${nodeId}`));
        }, timeoutMs);
      });

      return Promise.race([execPromise, timeoutPromise]).finally(() => {
        clearTimeout(timer);
      });
    }

    throw new Error(`Unknown node type: ${node.type}`);
  }

  /** Read a file from a specific node as Buffer (binary safe) */
  public async readFileBufferFromNode(nodeId: string, filePath: string): Promise<Buffer> {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    if (node.type === "local") {
      const verifiedPath = this.normalizeAndVerifyPath(node, filePath);
      return fs.readFileSync(verifiedPath);
    }

    let conn = this.getSshConnection(nodeId);
    if (!conn) {
      await this.connectSshNode(nodeId);
      conn = this.getSshConnection(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection to node ${nodeId}`);

    const remotePath = this.normalizeAndVerifyPath(node, filePath);
    const buffer = await conn.sftp.get(remotePath);
    if (Buffer.isBuffer(buffer)) return buffer;
    return Buffer.from(buffer as any);
  }

  /** Read a file from a specific node */
  public async readFileFromNode(nodeId: string, filePath: string): Promise<string> {
    const buf = await this.readFileBufferFromNode(nodeId, filePath);
    return buf.toString("utf-8");
  }

  /** Write a file to a specific node (supports string or Buffer for binary safety) */
  public async writeFileToNode(nodeId: string, filePath: string, content: string | Buffer): Promise<void> {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8");

    if (node.type === "local") {
      const verifiedPath = this.normalizeAndVerifyPath(node, filePath);
      const dir = path.dirname(verifiedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(verifiedPath, buffer);
      return;
    }

    let conn = this.getSshConnection(nodeId);
    if (!conn) {
      await this.connectSshNode(nodeId);
      conn = this.getSshConnection(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection to node ${nodeId}`);

    const remotePath = this.normalizeAndVerifyPath(node, filePath);
    const dir = path.posix.dirname(remotePath);
    try { await conn.sftp.mkdir(dir, true); } catch {}
    await conn.sftp.put(buffer, remotePath);
  }

  /** Execute a command across all nodes in the chain */
  public async execOnAllNodes(
    command: string,
    cwd?: string,
    timeoutMs?: number
  ): Promise<CrossWorkspaceResult[]> {
    if (!this.activeChain) {
      throw new Error("No active workspace chain");
    }
    const results: CrossWorkspaceResult[] = [];
    for (const node of this.activeChain.nodes) {
      try {
        const res = await this.execOnNode(node.id, command, cwd, timeoutMs);
        const output = res.stdout + (res.stderr ? `\n--- STDERR ---\n${res.stderr}` : "");
        results.push({
          nodeId: node.id,
          nodeLabel: node.label,
          success: res.exitCode === 0,
          output: output || "(no output)",
          error: res.exitCode !== 0 ? `Exit code: ${res.exitCode}` : undefined,
        });
      } catch (err: any) {
        results.push({
          nodeId: node.id,
          nodeLabel: node.label,
          success: false,
          output: "",
          error: err.message,
        });
      }
    }
    return results;
  }

  /** Execute on nodes that the active node depends on */
  public async execOnDependencyNodes(
    command: string,
    cwd?: string,
    timeoutMs?: number
  ): Promise<CrossWorkspaceResult[]> {
    if (!this.activeChain || !this.activeNodeId) {
      throw new Error("No active chain or node");
    }
    const activeNode = this.getActiveNode();
    if (!activeNode?.dependsOn?.length) {
      return [];
    }
    const results: CrossWorkspaceResult[] = [];
    for (const depId of activeNode.dependsOn) {
      try {
        const res = await this.execOnNode(depId, command, cwd, timeoutMs);
        const output = res.stdout + (res.stderr ? `\n--- STDERR ---\n${res.stderr}` : "");
        results.push({
          nodeId: depId,
          nodeLabel: this.getNode(depId)?.label || depId,
          success: res.exitCode === 0,
          output: output || "(no output)",
          error: res.exitCode !== 0 ? `Exit code: ${res.exitCode}` : undefined,
        });
      } catch (err: any) {
        results.push({
          nodeId: depId,
          nodeLabel: this.getNode(depId)?.label || depId,
          success: false,
          output: "",
          error: err.message,
        });
      }
    }
    return results;
  }

  /** Disconnect a specific SSH node */
  public async disconnectNode(nodeId: string): Promise<void> {
    const conn = this.sshConnections.get(nodeId);
    if (!conn) return;
    try { await conn.sftp.end(); } catch {}
    try { conn.client.end(); } catch {}
    this.sshConnections.delete(nodeId);
    sshLogger.info("chain.disconnect", `SSH node ${nodeId} disconnected`);
  }

  /** Disconnect all SSH connections */
  public async disconnectAll(): Promise<void> {
    const nodeIds = Array.from(this.sshConnections.keys());
    for (const nodeId of nodeIds) {
      await this.disconnectNode(nodeId);
    }
  }

  /** Get connection status for all nodes */
  public getConnectionStatus(): Array<{ nodeId: string; connected: boolean; type: string }> {
    if (!this.activeChain) return [];
    return this.activeChain.nodes.map(node => ({
      nodeId: node.id,
      connected: node.type === "local" ? true : this.sshConnections.has(node.id),
      type: node.type,
    }));
  }

  /** Get health metrics for a specific node */
  public async getNodeHealth(nodeId: string): Promise<{
    nodeId: string;
    label: string;
    type: string;
    role: string;
    status: "CONNECTED" | "DISCONNECTED" | "LOCAL" | "ERROR";
    pingMs: number;
    osInfo: string;
    uptime: string;
    ramUsage: string;
    diskUsage: string;
    error?: string;
  }> {
    const node = this.getNode(nodeId);
    if (!node) {
      throw new Error(`Node not found: ${nodeId}`);
    }

    if (node.type === "local") {
      const start = Date.now();
      const freeMem = (os.freemem() / (1024 * 1024 * 1024)).toFixed(1);
      const totalMem = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(1);
      const uptimeHours = (os.uptime() / 3600).toFixed(1);
      return {
        nodeId: node.id,
        label: node.label,
        type: node.type,
        role: node.role,
        status: "LOCAL",
        pingMs: Date.now() - start,
        osInfo: `${os.type()} ${os.release()} (${os.arch()})`,
        uptime: `${uptimeHours} hours`,
        ramUsage: `${(Number(totalMem) - Number(freeMem)).toFixed(1)}GB / ${totalMem}GB`,
        diskUsage: "Local Filesystem",
      };
    }

    // SSH node
    const start = Date.now();
    try {
      const res = await this.execOnNode(
        nodeId,
        `uname -sr; uptime -p 2>/dev/null || uptime; free -h 2>/dev/null | awk '/Mem:/ {print $3 "/" $2}'; df -h . | awk 'NR==2 {print $3 "/" $2 " (" $5 ")"}'`,
        ".",
        15000
      );
      const pingMs = Date.now() - start;
      const lines = res.stdout.trim().split("\n");
      return {
        nodeId: node.id,
        label: node.label,
        type: node.type,
        role: node.role,
        status: "CONNECTED",
        pingMs,
        osInfo: lines[0] || "Linux/POSIX",
        uptime: lines[1] || "unknown",
        ramUsage: lines[2] || "N/A",
        diskUsage: lines[3] || "N/A",
      };
    } catch (err: any) {
      return {
        nodeId: node.id,
        label: node.label,
        type: node.type,
        role: node.role,
        status: "ERROR",
        pingMs: Date.now() - start,
        osInfo: "N/A",
        uptime: "N/A",
        ramUsage: "N/A",
        diskUsage: "N/A",
        error: err.message,
      };
    }
  }

  /** Get health monitoring dashboard table for all nodes in the active chain */
  public async getChainHealth(): Promise<string> {
    if (!this.activeChain) {
      return "No active workspace chain.";
    }
    const promises = this.activeChain.nodes.map((node) => this.getNodeHealth(node.id));
    const results = await Promise.all(promises);

    const rows = results.map((h) => {
      const pingStr = `${h.pingMs}ms`;
      const statusBadge = h.status === "ERROR" ? `❌ ERROR (${h.error})` : `✅ ${h.status}`;
      return `| \`${h.nodeId}\` | ${h.label} | ${h.role} | ${h.type} | ${statusBadge} | ${pingStr} | ${h.ramUsage} | ${h.diskUsage} | ${h.uptime} |`;
    });

    const table = [
      `### 📊 Workspace Chain Health Dashboard: ${this.activeChain.name} (${this.activeChain.id})`,
      "",
      "| Node ID | Label | Role | Type | Status | Ping | RAM Usage | Disk Usage | Uptime |",
      "|---------|-------|------|------|--------|------|-----------|------------|--------|",
      ...rows,
    ].join("\n");

    return table;
  }

  /** Compare a file across two nodes in the chain */
  public async diffNodes(
    sourceNodeId: string,
    targetNodeId: string,
    filePath: string
  ): Promise<string> {
    const sourceNode = this.getNode(sourceNodeId);
    const targetNode = this.getNode(targetNodeId);
    if (!sourceNode) throw new Error(`Source node not found: ${sourceNodeId}`);
    if (!targetNode) throw new Error(`Target node not found: ${targetNodeId}`);

    let sourceContent: string | null = null;
    let targetContent: string | null = null;
    let sourceErr: string | null = null;
    let targetErr: string | null = null;

    try {
      sourceContent = await this.readFileFromNode(sourceNodeId, filePath);
    } catch (e: any) {
      sourceErr = e.message;
    }

    try {
      targetContent = await this.readFileFromNode(targetNodeId, filePath);
    } catch (e: any) {
      targetErr = e.message;
    }

    const sourceLabel = `${sourceNode.label} (${sourceNodeId})`;
    const targetLabel = `${targetNode.label} (${targetNodeId})`;

    if (sourceErr && targetErr) {
      return `[Diff Failed]\nSource (${sourceLabel}): ${sourceErr}\nTarget (${targetLabel}): ${targetErr}`;
    }

    if (sourceErr) {
      return `[Diff Result: Missing on Source]\nFile "${filePath}" exists on ${targetLabel} but failed to read from ${sourceLabel}: ${sourceErr}`;
    }

    if (targetErr) {
      return `[Diff Result: Missing on Target]\nFile "${filePath}" exists on ${sourceLabel} (${sourceContent?.length} bytes) but does not exist on ${targetLabel}: ${targetErr}`;
    }

    if (sourceContent === targetContent) {
      return `[Diff Result: IDENTICAL]\nFile "${filePath}" is identical between ${sourceLabel} and ${targetLabel} (${sourceContent?.length} bytes).`;
    }

    // Line by line diff summary
    const srcLines = (sourceContent || "").split("\n");
    const tgtLines = (targetContent || "").split("\n");

    return [
      `[Diff Result: MODIFIED] File: "${filePath}"`,
      `Source: ${sourceLabel} (${srcLines.length} lines, ${sourceContent?.length} bytes)`,
      `Target: ${targetLabel} (${tgtLines.length} lines, ${targetContent?.length} bytes)`,
      "",
      `--- ${sourceLabel}/${filePath}`,
      `+++ ${targetLabel}/${filePath}`,
      `@@ Line count delta: ${tgtLines.length - srcLines.length} @@`,
    ].join("\n");
  }

  /** Helper to load dynamic ignore patterns from .gitignore and .superagentignore */
  private loadIgnorePatterns(dirPath: string, customIgnores?: string[]): string[] {
    const defaultIgnores = ["node_modules", ".git", "dist", ".ds_store", "thumbs.db", "coverage"];
    const patterns = new Set<string>([...defaultIgnores, ...(customIgnores || [])]);

    const ignoreFiles = [".gitignore", ".superagentignore"];
    for (const ignoreFile of ignoreFiles) {
      const fullPath = path.join(dirPath, ignoreFile);
      if (fs.existsSync(fullPath)) {
        try {
          const lines = fs.readFileSync(fullPath, "utf-8").split("\n");
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
              patterns.add(trimmed.replace(/^\/+/, "").replace(/\/+$/, ""));
            }
          }
        } catch {}
      }
    }
    return Array.from(patterns);
  }

  /** Calculate SHA-256 checksum of Buffer */
  private getBufferChecksum(buffer: Buffer): string {
    return crypto.createHash("sha256").update(buffer).digest("hex");
  }

  /** Sync a file or directory from source node to target node */
  public async syncNodes(
    sourceNodeId: string,
    targetNodeId: string,
    sourcePath: string,
    targetPath?: string,
    options?: {
      ignorePatterns?: string[];
      maxConcurrency?: number;
      dryRun?: boolean;
      checksumCheck?: boolean;
      direction?: "push" | "pull";
    }
  ): Promise<string> {
    let effectiveSourceNodeId = sourceNodeId;
    let effectiveTargetNodeId = targetNodeId;
    let effectiveSourcePath = sourcePath;
    let effectiveTargetPath = targetPath || sourcePath;

    // Support bidirectional sync (pull mode reverses source and target)
    if (options?.direction === "pull") {
      effectiveSourceNodeId = targetNodeId;
      effectiveTargetNodeId = sourceNodeId;
      effectiveSourcePath = targetPath || sourcePath;
      effectiveTargetPath = sourcePath;
    }

    const sourceNode = this.getNode(effectiveSourceNodeId);
    const targetNode = this.getNode(effectiveTargetNodeId);
    if (!sourceNode) throw new Error(`Source node not found: ${effectiveSourceNodeId}`);
    if (!targetNode) throw new Error(`Target node not found: ${effectiveTargetNodeId}`);

    const isDryRun = !!options?.dryRun;
    const useChecksum = !!options?.checksumCheck;
    const maxConcurrency = options?.maxConcurrency || 5;

    sshLogger.info(
      "chain.sync",
      `syncing ${effectiveSourcePath} from ${effectiveSourceNodeId} to ${effectiveTargetNodeId}:${effectiveTargetPath} (dryRun=${isDryRun})`
    );

    // Check if source path is a local directory
    if (sourceNode.type === "local") {
      const verifiedSource = this.normalizeAndVerifyPath(sourceNode, effectiveSourcePath);
      if (fs.existsSync(verifiedSource) && fs.statSync(verifiedSource).isDirectory()) {
        const ignores = this.loadIgnorePatterns(verifiedSource, options?.ignorePatterns);

        const shouldIgnore = (relPath: string) => {
          const lower = relPath.toLowerCase();
          return ignores.some((pat) => lower === pat.toLowerCase() || lower.startsWith(`${pat.toLowerCase()}/`));
        };

        const fileTasks: Array<{ localPath: string; destPath: string; relPath: string }> = [];

        const scanRecursive = (currentLocalDir: string, currentRelativePath: string) => {
          const entries = fs.readdirSync(currentLocalDir, { withFileTypes: true });
          for (const entry of entries) {
            const entryRelPath = currentRelativePath ? `${currentRelativePath}/${entry.name}` : entry.name;
            if (shouldIgnore(entryRelPath) || shouldIgnore(entry.name)) continue;

            const entryLocalPath = path.join(currentLocalDir, entry.name);
            const entryDestPath = effectiveTargetPath
              ? `${effectiveTargetPath.replace(/\\/g, "/").replace(/\/$/, "")}/${entryRelPath}`
              : entryRelPath;

            if (entry.isDirectory()) {
              scanRecursive(entryLocalPath, entryRelPath);
            } else if (entry.isFile()) {
              fileTasks.push({ localPath: entryLocalPath, destPath: entryDestPath, relPath: entryRelPath });
            }
          }
        };

        scanRecursive(verifiedSource, "");

        let copiedFiles = 0;
        let skippedFiles = 0;
        let totalBytes = 0;
        const transferredList: string[] = [];

        // Process file transfers in parallel batches (maxConcurrency)
        for (let i = 0; i < fileTasks.length; i += maxConcurrency) {
          const chunk = fileTasks.slice(i, i + maxConcurrency);
          await Promise.all(
            chunk.map(async (task) => {
              const srcBuffer = fs.readFileSync(task.localPath);
              const srcHash = useChecksum ? this.getBufferChecksum(srcBuffer) : "";

              let skip = false;
              if (useChecksum && !isDryRun) {
                try {
                  const destBuffer = await this.readFileBufferFromNode(effectiveTargetNodeId, task.destPath);
                  if (this.getBufferChecksum(destBuffer) === srcHash) {
                    skip = true;
                  }
                } catch {}
              }

              if (skip) {
                skippedFiles++;
                return;
              }

              if (!isDryRun) {
                await this.writeFileToNode(effectiveTargetNodeId, task.destPath, srcBuffer);
              }
              copiedFiles++;
              totalBytes += srcBuffer.length;
              transferredList.push(task.relPath);
            })
          );
        }

        const modeLabel = isDryRun ? "[DRY RUN PREVIEW] " : "";
        const dirLabel = options?.direction === "pull" ? "PULLED (Remote -> Local)" : "PUSHED (Local -> Remote)";

        return (
          `✅ ${modeLabel}Successfully synced directory (${dirLabel})\n` +
          `Source Node: ${sourceNode.label} (${effectiveSourceNodeId})\n` +
          `Target Node: ${targetNode.label} (${effectiveTargetNodeId})\n` +
          `Directory:   ${effectiveSourcePath} -> ${effectiveTargetPath}\n` +
          `Files Transferred: ${copiedFiles}\n` +
          `Files Skipped (Unchanged Delta): ${skippedFiles}\n` +
          `Total Size: ${totalBytes} bytes\n` +
          `Ignored Rules Count: ${ignores.length}`
        );
      }
    }

    const buf = await this.readFileBufferFromNode(effectiveSourceNodeId, effectiveSourcePath);

    let skipped = false;
    if (useChecksum && !isDryRun) {
      try {
        const destBuf = await this.readFileBufferFromNode(effectiveTargetNodeId, effectiveTargetPath);
        if (this.getBufferChecksum(buf) === this.getBufferChecksum(destBuf)) {
          skipped = true;
        }
      } catch {}
    }

    if (!skipped && !isDryRun) {
      await this.writeFileToNode(effectiveTargetNodeId, effectiveTargetPath, buf);
    }

    const modeLabel = isDryRun ? "[DRY RUN PREVIEW] " : "";
    const statusMsg = skipped ? "SKIPPED (Unchanged)" : "TRANSFERRED";

    return (
      `✅ ${modeLabel}Sync File (${statusMsg})\n` +
      `Source Node: ${sourceNode.label} (${effectiveSourceNodeId}:${effectiveSourcePath})\n` +
      `Target Node: ${targetNode.label} (${effectiveTargetNodeId}:${effectiveTargetPath})\n` +
      `Size: ${buf.length} bytes`
    );
  }
}

/** Singleton instance */
export const workspaceChainManager = new WorkspaceChainManagerClass();