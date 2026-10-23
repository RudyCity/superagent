import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const storage = () => path.join(os.homedir(), ".superagent-r", "yolo-blocklist.json");
const normalize = (value: string): string => {
  if (!value.trim()) throw new Error("Empty path");
  const p = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path;
  const absolute = p.resolve(value.trim().replace(/^["']|["']$/g, ""));
  let existing = absolute;
  const rest: string[] = [];
  while (!fs.existsSync(existing) && p.dirname(existing) !== existing) {
    rest.unshift(p.basename(existing));
    existing = p.dirname(existing);
  }
  let resolved = absolute;
  try { resolved = p.join(fs.realpathSync.native(existing), ...rest); } catch {}
  return p.normalize(resolved).replace(/[\\/]+$/, "").toLowerCase();
};
export function listYoloBlocks(): string[] {
  try { const data: unknown = JSON.parse(fs.readFileSync(storage(), "utf8")); return Array.isArray(data) ? data.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}
export function editYoloBlocks(action: "add" | "remove" | "clear", target?: string): string[] {
  const current = listYoloBlocks();
  if (action !== "clear" && !target) throw new Error("Path or drive is required");
  const value = target ? normalize(target) : "";
  const next = action === "clear" ? [] : action === "add" ? [...new Set([...current, value])] : current.filter(v => v !== value);
  fs.mkdirSync(path.dirname(storage()), { recursive: true });
  fs.writeFileSync(storage(), JSON.stringify(next, null, 2));
  return next;
}
export function blockedYoloPath(target: string, cwd = process.cwd()): string | undefined {
  let full: string;
  try { full = normalize(path.isAbsolute(target) || /^[a-z]:[\\/]/i.test(target) ? target : path.resolve(cwd, target)); }
  catch { return undefined; }
  return listYoloBlocks().find(root => full === root || full.startsWith(root + (/^[a-z]:/i.test(root) ? "\\" : root.includes("\\") ? "\\" : "/")));
}
/** Conservative check of explicit tool arguments; arbitrary interpreted shell code needs OS sandboxing. */
export function blockedYoloToolCall(args: Record<string, unknown> = {}, cwd = process.cwd()): string | undefined {
  const base = typeof args.cwd === "string" ? args.cwd : cwd;
  const visit = (node: unknown, key = ""): string | undefined => {
    if (Array.isArray(node)) return node.map(v => visit(v, key)).find(Boolean);
    if (node && typeof node === "object") return Object.entries(node).map(([k,v]) => visit(v,k)).find(Boolean);
    if (typeof node !== "string") return undefined;
    if (/^(command|cmd|script|input|commandline)$/i.test(key)) {
      for (const root of listYoloBlocks()) if (node.toLowerCase().includes(root)) return root;
      const tokens = node.match(/[a-z]:[\\/][^\s"';&|]+|\.\.?[\\/][^\s"';&|]+/gi) ?? [];
      return tokens.map(v => blockedYoloPath(v, base)).find(Boolean);
    }
    if (/path|file|dir|workspace|cwd|root|destination|source|target/i.test(key)) return blockedYoloPath(node, base);
    return undefined;
  };
  return visit(args) || blockedYoloPath(base);
}
