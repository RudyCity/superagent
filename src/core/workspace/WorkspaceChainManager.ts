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
  public loadActiveChain(): WorkspaceChain | null {
    const chainId = getActiveChainId();
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
  public getActiveChain(): WorkspaceChain | null {
    if (!this.activeChain) {
      return this.loadActiveChain();
    }
    return this.activeChain;
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
    return true;
  }

  /** Activate a chain by ID */
  public async activateChain(chainId: string): Promise<WorkspaceChain> {
    const chain = getWorkspaceChain(chainId);
    if (!chain) {
      throw new Error(`Workspace chain not found: ${chainId}`);
    }
    await this.disconnectAll();
    this.activeChain = chain;
    this.activeNodeId = chain.primaryNodeId;
    setActiveChainId(chainId);
    return chain;
  }

  /** Deactivate the current chain */
  public async deactivateChain(): Promise<void> {
    await this.disconnectAll();
    this.activeChain = null;
    this.activeNodeId = null;
    setActiveChainId(null);
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
  public isChainActive(): boolean {
    return this.activeChain !== null;
  }

  /** Connect to an SSH node in the chain */
  public async connectSshNode(nodeId: string): Promise<void> {
    if (this.sshConnections.has(nodeId)) return;
    if (this.connectingPromises.has(nodeId)) {
      return this.connectingPromises.get(nodeId)!;
    }

    const node = this.getNode(nodeId);
    if (!node || node.type !== "ssh" || !node.sshConfig) {
      throw new Error(`Node ${nodeId} is not an SSH node or missing SSH config`);
    }

    const promise = this._doConnectSsh(nodeId, node.sshConfig).finally(() => {
      this.connectingPromises.delete(nodeId);
    });
    this.connectingPromises.set(nodeId, promise);
    return promise;
  }

  /** Internal SSH connection logic */
  private async _doConnectSsh(nodeId: string, config: NonNullable<WorkspaceNode["sshConfig"]>): Promise<void> {
    sshLogger.info("chain.connect", `connecting to SSH node ${nodeId}`, {
      host: config.host,
      user: config.username,
      remoteCwd: config.remoteCwd,
    });

    const privateKey = config.privateKeyPath
      ? fs.readFileSync(config.privateKeyPath)
      : this.findDefaultPrivateKey();

    const connectConfig: any = {
      host: config.host,
      port: config.port,
      username: config.username,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      readyTimeout: config.readyTimeout || 15000,
    };

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

    const client = await new Promise<Client>((resolve, reject) => {
      const c = new Client();
      c.on("ready", () => resolve(c))
        .on("error", (err) => reject(new Error(`SSH connection failed to ${config.host}:${config.port} — ${err.message}`)))
        .connect(connectConfig);
    });

    const sftp = new SFTPClient();
    await sftp.connect(connectConfig);

    this.sshConnections.set(nodeId, {
      nodeId,
      client,
      sftp,
      config,
    });

    sshLogger.info("chain.connect", `SSH node ${nodeId} connected`, { host: config.host });
  }

  /** Find default SSH private key */
  private findDefaultPrivateKey(): Buffer | undefined {
    const defaultKeys = ["id_ed25519", "id_rsa", "id_ecdsa"];
    const sshDir = path.join(os.homedir(), ".ssh");
    for (const key of defaultKeys) {
      const keyPath = path.join(sshDir, key);
      if (fs.existsSync(keyPath)) {
        try { return fs.readFileSync(keyPath); } catch {}
      }
    }
    return undefined;
  }

  /** Get SSH connection for a node */
  public getSshConnection(nodeId: string): ChainSshConnection | null {
    return this.sshConnections.get(nodeId) || null;
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
      const workingDir = cwd || node.path || process.cwd();
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

      const remoteCwd = cwd || node.sshConfig?.remoteCwd || ".";
      const esc = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const fullCommand = `cd ${esc(remoteCwd)} && ${command}`;

      return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`SSH execution timed out after ${timeoutMs}ms on node ${nodeId}`));
          }
        }, timeoutMs);

        conn!.client.exec(fullCommand, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            reject(err);
            return;
          }
          stream.on("data", (data: Buffer) => { stdout += data.toString(); });
          stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
          stream.on("close", (code: number | null) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ stdout, stderr, exitCode: code ?? 0 });
            }
          });
          stream.on("error", (streamErr: Error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(streamErr);
            }
          });
        });
      });
    }

    throw new Error(`Unknown node type: ${node.type}`);
  }

  /** Read a file from a specific node */
  public async readFileFromNode(nodeId: string, filePath: string): Promise<string> {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    if (node.type === "local") {
      const fullPath = path.resolve(node.path || process.cwd(), filePath);
      return fs.readFileSync(fullPath, "utf-8");
    }

    let conn = this.getSshConnection(nodeId);
    if (!conn) {
      await this.connectSshNode(nodeId);
      conn = this.getSshConnection(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection to node ${nodeId}`);

    const remotePath = filePath.startsWith("/")
      ? filePath
      : `${node.sshConfig?.remoteCwd}/${filePath}`.replace(/\/+/g, "/");
    const buffer = await conn.sftp.get(remotePath);
    if (Buffer.isBuffer(buffer)) {
      return buffer.toString("utf-8");
    }
    return String(buffer);
  }

  /** Write a file to a specific node */
  public async writeFileToNode(nodeId: string, filePath: string, content: string): Promise<void> {
    const node = this.getNode(nodeId);
    if (!node) throw new Error(`Node not found: ${nodeId}`);

    if (node.type === "local") {
      const fullPath = path.resolve(node.path || process.cwd(), filePath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, "utf-8");
      return;
    }

    let conn = this.getSshConnection(nodeId);
    if (!conn) {
      await this.connectSshNode(nodeId);
      conn = this.getSshConnection(nodeId);
    }
    if (!conn) throw new Error(`No SSH connection to node ${nodeId}`);

    const remotePath = filePath.startsWith("/")
      ? filePath
      : `${node.sshConfig?.remoteCwd}/${filePath}`.replace(/\/+/g, "/");
    const dir = path.posix.dirname(remotePath);
    try { await conn.sftp.mkdir(dir, true); } catch {}
    await conn.sftp.put(Buffer.from(content, "utf-8"), remotePath);
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
}

/** Singleton instance */
export const workspaceChainManager = new WorkspaceChainManagerClass();