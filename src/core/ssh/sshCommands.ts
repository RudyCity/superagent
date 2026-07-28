import { sshProxy } from "./sshProxy.js";

export async function sshReadToolExecute(filePath: string | Array<string | { path: string }>): Promise<string> {
  try {
    if (Array.isArray(filePath)) {
      const results: string[] = [];
      for (const item of filePath) {
        const pathStr = typeof item === "string" ? item : item.path;
        try {
          const content = await sshProxy.readFile(pathStr);
          results.push(`=== File: ${pathStr} ===\n${content}`);
        } catch (err: any) {
          results.push(`=== File: ${pathStr} ===\nError reading file: ${err.message}`);
        }
      }
      return results.join("\n\n");
    }
    return await sshProxy.readFile(filePath);
  } catch (err: any) {
    return `Error reading SSH remote file: ${err.message}`;
  }
}

export async function sshWriteToolExecute(
  filePath: string | Array<{ filePath: string; content: string }>,
  content?: string
): Promise<string> {
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

export async function sshRunCommandExecute(command: string, cwd?: string): Promise<string> {
  try {
    const res = await sshProxy.exec(command, cwd);
    let output = res.stdout;
    if (res.stderr) {
      output += (output ? "\n--- STDERR ---\n" : "") + res.stderr;
    }
    if (res.exitCode !== 0) {
      output += `\n[Process exited with status code ${res.exitCode}]`;
    }
    return output || "(no output)";
  } catch (err: any) {
    return `Error executing remote SSH command: ${err.message}`;
  }
}

export async function sshRunBackgroundProcessExecute(command: string, cwd?: string): Promise<string> {
  try {
    const pid = await sshProxy.execBackground(command, ".superagent-bg.log", cwd);
    return `Started remote background process PID ${pid}. Output logged to .superagent-bg.log on SSH remote host.`;
  } catch (err: any) {
    return `Error starting remote SSH background process: ${err.message}`;
  }
}

export async function sshGlobToolExecute(pattern: string): Promise<string> {
  try {
    const res = await sshProxy.exec(`find . -path "${pattern}" -o -name "${pattern}" 2>/dev/null | head -n 500`);
    return res.stdout || "No files found matching pattern.";
  } catch (err: any) {
    return `Error running remote SSH glob: ${err.message}`;
  }
}

export async function sshGrepToolExecute(pattern: string, pathPattern?: string): Promise<string> {
  try {
    const cmd = pathPattern
      ? `grep -rnE "${pattern}" --include="${pathPattern}" . | head -n 200`
      : `grep -rnE "${pattern}" . | head -n 200`;
    const res = await sshProxy.exec(cmd);
    return res.stdout || "No matches found.";
  } catch (err: any) {
    return `Error running remote SSH grep: ${err.message}`;
  }
}
