/**
 * Integrity gate for the optional Python Vision helper shipped with the
 * standalone Core. Python/model wheels remain separately installed by an
 * operator; never invoke pip or download weights during packaging.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const VISION_STANDALONE_RELATIVE = path.join("scripts", "vision_server.py");

function verifiedFile(file: string): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1024 ||
      stat.size > 1024 * 1024) {
    throw new Error("VISION_STANDALONE_UNTRUSTED_FILE: " + file);
  }
  return fs.readFileSync(file);
}

export function verifyVisionStandaloneAsset(root: string, stagedRoot: string): string {
  const source = verifiedFile(path.join(root, VISION_STANDALONE_RELATIVE));
  const staged = verifiedFile(path.join(stagedRoot, VISION_STANDALONE_RELATIVE));
  if (!source.equals(staged)) throw new Error("VISION_STANDALONE_SOURCE_MISMATCH");
  return createHash("sha256").update(staged).digest("hex");
}

export function stageVisionStandaloneAsset(root: string, stagedRoot: string): string {
  const source = path.join(root, VISION_STANDALONE_RELATIVE);
  verifiedFile(source);
  const target = path.join(stagedRoot, VISION_STANDALONE_RELATIVE);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Stage is freshly generated; an unexpected existing helper is suspicious.
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  return verifyVisionStandaloneAsset(root, stagedRoot);
}
