import fs from "node:fs/promises";
import path from "node:path";
import { isPathInsideOrEqual } from "../../utils/serverSecurity.js";
import { motionWorkspaceRoot } from "../project/projectStore.js";

/** Read a local user-selected input without allowing workspace escape or symlink inputs. */
export async function readMotionWorkspaceInput(workspace: string, filename: string, maxBytes: number): Promise<Buffer> {
  if (typeof filename !== "string" || !filename.trim() || filename.includes("\0")) {
    throw new Error("Motion input file is required");
  }
  const root = await motionWorkspaceRoot(workspace);
  const candidate = path.resolve(root, filename);
  const canonical = await fs.realpath(candidate);
  if (!isPathInsideOrEqual(root, canonical)) throw new Error("Motion input file outside workspace");
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error("Invalid Motion input file type or size");
  }
  const data = await fs.readFile(candidate);
  if (data.length !== stat.size || data.length > maxBytes) throw new Error("Motion input file changed during read");
  return data;
}

/** Accept only canonical bounded base64 data; no paths, remote URLs, or encoded commands. */
export function decodeMotionMediaBase64(value: unknown, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length < 4 || value.length > 4 * Math.ceil(maxBytes / 3) ||
    value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Invalid Motion media base64");
  }
  const data = Buffer.from(value, "base64");
  if (data.length < 1 || data.length > maxBytes || data.toString("base64") !== value) {
    throw new Error("Invalid Motion media content or size");
  }
  return data;
}
