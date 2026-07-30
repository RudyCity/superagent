const fs = require('fs');
const filePath = 'src/core/ssh/sshProxy.ts';
let c = fs.readFileSync(filePath, 'utf-8');

// Add new imports
c = c.replace(
  'import { getActiveQuestionHandler } from "../tools/state.js";',
  'import { getActiveQuestionHandler } from "../tools/state.js";\nimport { sshEvents, SshConnectionState } from "./sshEvents.js";\nimport { resolveHostAlias, parseProxyJump } from "./sshConfig.js";'
);

// Configurable timeout
c = c.replace('readyTimeout: 15000,', 'readyTimeout: config.readyTimeout || 15000,');

// SSH compression
c = c.replace(
  'if (config.password) {\n        connectConfig.password = config.password;',
  'if (config.compression) {\n        connectConfig.compress = true;\n        sshLogger.info("connect", "SSH compression enabled");\n      }\n      if (config.agentForward) {\n        connectConfig.agentForward = true;\n        sshLogger.info("connect", "SSH agent forwarding enabled");\n      }\n      if (config.password) {\n        connectConfig.password = config.password;'
);

// SSH config file support
c = c.replace(
  'const privateKey = config.privateKeyPath',
  '// SSH config file support: resolve host alias from ~/.ssh/config\n      const alias = resolveHostAlias(config.host);\n      if (alias) {\n        if (alias.hostname) config.host = alias.hostname;\n        if (alias.user && config.username === "root") config.username = alias.user;\n        if (alias.identityFile && !config.privateKeyPath) config.privateKeyPath = alias.identityFile;\n        if (alias.proxyJump && !config.proxyJump) config.proxyJump = alias.proxyJump;\n        if (alias.compression !== undefined && config.compression === undefined) config.compression = alias.compression;\n        if (alias.forwardAgent !== undefined && config.agentForward === undefined) config.agentForward = alias.forwardAgent;\n        sshLogger.info("ssh_config", `resolved host alias from ~/.ssh/config`);\n      }\n\n      const privateKey = config.privateKeyPath'
);

// Connection state events on connect
c = c.replace(
  'this.lastActivityTime = Date.now();\n      this.isConnecting = false;\n    } catch (err) {\n      this.isConnecting = false;',
  'sshEvents.setState("connected", { host: config.host, port: config.port });\n      this.lastActivityTime = Date.now();\n      this.isConnecting = false;\n    } catch (err) {\n      this.isConnecting = false;\n      sshEvents.setState("error", { error: (err as Error).message });'
);

// Connection state events on disconnect
c = c.replace(
  'this.clearCache();\n    this.trackedPids.clear();\n\n    if (this.sftpClient)',
  'this.clearCache();\n    this.trackedPids.clear();\n    sshEvents.setState("disconnected");\n\n    if (this.sftpClient)'
);

// Add getConnectionState method after isPidTracked
c = c.replace(
  'public isPidTracked(pid: string): boolean {\n    return this.trackedPids.has(pid);\n  }',
  'public isPidTracked(pid: string): boolean {\n    return this.trackedPids.has(pid);\n  }\n\n  public getConnectionState(): SshConnectionState {\n    return sshEvents.getState();\n  }'
);

// Add port forwarding methods before disconnect
c = c.replace(
  'public async disconnect(): Promise<void> {',
  'private portForwards: Array<{ type: "local" | "remote"; localPort: number; remoteHost: string; remotePort: number }> = [];\n\n  public async addLocalPortForward(localPort: number, remoteHost: string, remotePort: number): Promise<void> {\n    await this.ensureConnected();\n    if (!this.sshClient) throw new Error("SSH client not connected");\n    return new Promise((resolve, reject) => {\n      this.sshClient!.forwardOut("127.0.0.1", localPort, remoteHost, remotePort, (err) => {\n        if (err) { reject(new Error(`Port forward failed: ${err.message}`)); return; }\n        const fwd = { type: "local" as const, localPort, remoteHost, remotePort };\n        this.portForwards.push(fwd);\n        sshEvents.emitPortForward(fwd);\n        sshLogger.info("port_forward", `local: 127.0.0.1:${localPort} -> ${remoteHost}:${remotePort}`);\n        resolve();\n      });\n    });\n  }\n\n  public getPortForwards(): Array<{ type: "local" | "remote"; localPort: number; remoteHost: string; remotePort: number }> {\n    return [...this.portForwards];\n  }\n\n  public async disconnect(): Promise<void> {'
);

// Clear port forwards on disconnect
c = c.replace(
  'this.trackedPids.clear();\n    sshEvents.setState("disconnected");',
  'this.trackedPids.clear();\n    this.portForwards = [];\n    sshEvents.setState("disconnected");'
);

// SFTP transfer progress on readFile
c = c.replace(
  'content = buf.toString("utf-8");\n    } else {',
  'content = buf.toString("utf-8");\n      sshEvents.emitTransferProgress({ path: remotePath, direction: "download", bytesTransferred: buf.length, totalBytes: buf.length, percent: 100 });\n    } else {'
);

// SFTP transfer progress on writeFile
c = c.replace(
  'await this.sftpClient!.put(Buffer.from(content, "utf-8"), target);\n\n    // Update smart cache',
  'const data = Buffer.from(content, "utf-8");\n    await this.sftpClient!.put(data, target);\n    sshEvents.emitTransferProgress({ path: remotePath, direction: "upload", bytesTransferred: data.length, totalBytes: data.length, percent: 100 });\n\n    // Update smart cache'
);

fs.writeFileSync(filePath, c, 'utf-8');
console.log('sshProxy.ts updated successfully');