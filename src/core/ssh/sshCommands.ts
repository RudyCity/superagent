import { sshProxy } from "./sshProxy.js";
import { sshLogger } from "./sshLogger.js";

function logToolEntry(op: string, meta: Record<string, unknown>): void {
  sshLogger.info(op, "tool entry", { meta });
}

function logToolExit(op: string, meta: Record<string, unknown>): void {
  sshLogger.info(op, "tool exit", { meta });
}

export async function sshReadToolExecute(
  filePath: string | Array<string | { path: string }>,
  offset: number = 1,
  limit: number = 800
): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.read", { files: Array.isArray(filePath) ? filePath.length : 1, offset, limit });
  try {
    const sliceContent = (content: string): string => {
      if (offset === 1 && limit >= 800 && content.split("\n").length <= limit) {
        return content;
      }
      const lines = content.split("\n");
      const startIdx = Math.max(0, offset - 1);
      const endIdx = startIdx + limit;
      const sliced = lines.slice(startIdx, endIdx);
      return sliced.map((line, idx) => `${startIdx + idx + 1}: ${line}`).join("\n");
    };

    if (Array.isArray(filePath)) {
      const results: string[] = [];
      for (const item of filePath) {
        const pathStr = typeof item === "string" ? item : item.path;
        try {
          const content = await sshProxy.readFile(pathStr);
          results.push(`=== File: ${pathStr} ===\n${sliceContent(content)}`);
        } catch (err: any) {
          results.push(`=== File: ${pathStr} ===\nError reading file: ${err.message}`);
        }
      }
      return results.join("\n\n");
    }
    const content = await sshProxy.readFile(filePath);
    const out = sliceContent(content);
    logToolExit("ssh.read", { files: Array.isArray(filePath) ? filePath.length : 1, durationMs: Date.now() - start, status: "ok" });
    return out;
  } catch (err: any) {
    logToolExit("ssh.read", { durationMs: Date.now() - start, status: "error", error: err.message });
    return `Error reading SSH remote file: ${err.message}`;
  }
}

export async function sshWriteToolExecute(
  filePath: string | Array<{ filePath: string; content: string }>,
  content?: string
): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.write", { files: Array.isArray(filePath) ? filePath.length : 1 });
  try {
    if (Array.isArray(filePath)) {
      const results: string[] = [];
      for (const file of filePath) {
        try {
          await sshProxy.writeFile(file.filePath, file.content);
          results.push(`Successfully wrote remote SSH file: ${file.filePath}`);
        } catch (err: any) {
          results.push(`Error writing SSH remote file ${file.filePath}: ${err.message}`);
        }
      }
      return results.join("\n");
    }
    if (!content && content !== "") {
      return "Error: Missing content for file write";
    }
    await sshProxy.writeFile(filePath, content);
    return `Successfully wrote remote SSH file: ${filePath}`;
  } catch (err: any) {
    return `Error writing SSH remote file: ${err.message}`;
  }
}

export async function sshEditToolExecute(filePath: string, oldString: string, newString: string): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.edit", { filePath });
  try {
    const original = await sshProxy.readFile(filePath);
    if (!original.includes(oldString)) {
      return `Error: target string not found in SSH remote file ${filePath}`;
    }
    const updated = original.replace(oldString, newString);
    await sshProxy.writeFile(filePath, updated);
    return `Successfully updated SSH remote file: ${filePath}`;
  } catch (err: any) {
    return `Error editing SSH remote file ${filePath}: ${err.message}`;
  }
}

export async function sshMultiEditToolExecute(
  filePath: string,
  chunks: Array<{ targetContent: string; replacementContent: string }>
): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.multi_edit", { filePath, chunks: chunks.length });
  try {
    let content = await sshProxy.readFile(filePath);
    let appliedCount = 0;
    for (const chunk of chunks) {
      if (!content.includes(chunk.targetContent)) {
        return `Error: target string "${chunk.targetContent.slice(0, 40)}..." not found in SSH remote file ${filePath}`;
      }
      content = content.replace(chunk.targetContent, chunk.replacementContent);
      appliedCount++;
    }
    await sshProxy.writeFile(filePath, content);
    return `Successfully applied ${appliedCount} chunk edit(s) to SSH remote file: ${filePath}`;
  } catch (err: any) {
    return `Error applying multi-edit to SSH remote file ${filePath}: ${err.message}`;
  }
}

export async function sshRunCommandExecute(command: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.run", { command, cwd });
  try {
    const res = await sshProxy.exec(command, cwd, timeoutMs, signal);
    let output = res.stdout;
    if (res.stderr) {
      output += (output ? "\n--- STDERR ---\n" : "") + res.stderr;
    }
    const exitCodeNum = typeof res.exitCode === "number" && !isNaN(res.exitCode) ? res.exitCode : 0;
    if (exitCodeNum !== 0) {
      output += `\n[Process exited with status code ${exitCodeNum}]`;
    }
    return output || "(no output)";
  } catch (err: any) {
    return `Error executing remote SSH command: ${err.message}`;
  }
}

export async function sshRunBackgroundProcessExecute(command: string, cwd?: string): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.run_bg", { command, cwd });
  try {
    const pid = await sshProxy.execBackground(command, ".superagent-bg.log", cwd);
    return `Started remote background process PID ${pid}. Output logged to .superagent-bg.log on SSH remote host.`;
  } catch (err: any) {
    return `Error starting remote SSH background process: ${err.message}`;
  }
}

export async function sshKillBackgroundProcessExecute(processId: string): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.kill_bg", { processId });
  try {
    const res = await sshProxy.exec(`kill -9 ${sshProxy.escapeShellArg(processId)} 2>/dev/null || true`);
    return `Sent termination signal to remote SSH background process PID ${processId}.`;
  } catch (err: any) {
    return `Error terminating remote SSH background process: ${err.message}`;
  }
}

export async function sshViewBackgroundProcessesExecute(processId?: string): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.view_bg", { processId });
  try {
    if (processId) {
      const res = await sshProxy.exec(`ps -p ${sshProxy.escapeShellArg(processId)} -o pid,stat,time,command 2>/dev/null || echo "Process not running."`);
      const logRes = await sshProxy.exec(`tail -n 50 .superagent-bg.log 2>/dev/null || true`);
      return `Remote Process PID ${processId}:\n${res.stdout}\n\nRecent Log Output (.superagent-bg.log):\n${logRes.stdout || "(empty)"}`;
    }
    const res = await sshProxy.exec(`ps aux | grep -i superagent-bg | grep -v grep || echo "No active SSH background processes found."`);
    return `Remote SSH Background Processes:\n${res.stdout}`;
  } catch (err: any) {
    return `Error viewing remote SSH background processes: ${err.message}`;
  }
}

export async function sshManageBackgroundProcessExecute(
  action: string,
  processId?: string,
  input?: string
): Promise<string> {
  if (action === "list") {
    return sshViewBackgroundProcessesExecute();
  }
  if (!processId) {
    return "Error: processId is required for SSH background process actions.";
  }
  if (action === "kill") {
    return sshKillBackgroundProcessExecute(processId);
  }
  if (action === "status") {
    return sshViewBackgroundProcessesExecute(processId);
  }
  if (action === "send_input") {
    return "Notice: Interactive stdin input is not supported for remote SSH background processes.";
  }
  return `Error: Unknown background process action "${action}" for SSH remote workspace.`;
}

export async function sshGlobToolExecute(pattern: string, signal?: AbortSignal): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.glob", { pattern });
  try {
    const escapedPattern = sshProxy.escapeShellArg(pattern);
    const res = await sshProxy.exec(`find . -path ${escapedPattern} -o -name ${escapedPattern} 2>/dev/null | head -n 500`, undefined, 600000, signal);
    // CRITICAL: surface stream/SSH failures instead of silently returning "No files found".
    // When exec() fails (exitCode -1) but stdout happens to be empty, the previous
    // `res.stdout || "No files found."` masked real errors. Now any non-zero exit
    // returns the error so the agent can see what actually went wrong.
    if (res.exitCode !== 0) {
      const errMsg = (res.stderr || `exit code ${res.exitCode}`).trim();
      return `Error running remote SSH glob: ${errMsg}`;
    }
    return res.stdout || "No files found matching pattern.";
  } catch (err: any) {
    return `Error running remote SSH glob: ${err.message}`;
  }
}

export async function sshGrepToolExecute(pattern: string, pathPattern?: string, signal?: AbortSignal): Promise<string> {
  const start = Date.now();
  logToolEntry("ssh.grep", { pattern, pathPattern });
  try {
    const escapedPattern = sshProxy.escapeShellArg(pattern);
    const cmd = pathPattern
      ? `grep -rnE ${escapedPattern} --include=${sshProxy.escapeShellArg(pathPattern)} . | head -n 200`
      : `grep -rnE ${escapedPattern} . | head -n 200`;
    const res = await sshProxy.exec(cmd, undefined, 600000, signal);
    // CRITICAL: same fix as sshGlobToolExecute — surface SSH failures instead of
    // silently returning "No matches found" when exit is non-zero.
    if (res.exitCode !== 0) {
      const errMsg = (res.stderr || `exit code ${res.exitCode}`).trim();
      return `Error running remote SSH grep: ${errMsg}`;
    }
    return res.stdout || "No matches found.";
  } catch (err: any) {
    return `Error running remote SSH grep: ${err.message}`;
  }
}

