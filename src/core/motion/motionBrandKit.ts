import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { motionStorageDir } from "./project/projectStore.js";
import { readMotionAsset } from "./assets/motionAssets.js";
import { MotionValidationError } from "./schema/validation.js";
import { MOTION_FONT_FAMILIES, type MotionFontFamily } from "./schema/fontCatalog.js";

export interface MotionBrandKit {
  revision: number;
  name: string;
  primary: string;
  accent: string;
  background: string;
  textColor: string;
  fontFamily: MotionFontFamily;
  logoAssetId?: string;
  updatedAt: string;
}
export type MotionBrandKitInput = Pick<MotionBrandKit,
  "name" | "primary" | "accent" | "background" | "textColor" | "fontFamily" | "logoAssetId">;

const hex = /^#[0-9A-Fa-f]{6}$/;
const fontNames = new Set<string>(MOTION_FONT_FAMILIES);
const asset = /^asset-[a-f0-9]{64}$/;
const defaults: MotionBrandKit = {
  revision: 0, name: "Workspace Brand", primary: "#38BDF8",
  accent: "#F97316", background: "#171B28", textColor: "#F7F8FF",
  fontFamily: "Arial", updatedAt: "",
};
function validate(input: unknown): asserts input is MotionBrandKitInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new MotionValidationError(["Brand Kit must be an object"]);
  const kit = input as Record<string, unknown>;
  const keys = ["name", "primary", "accent", "background", "textColor", "fontFamily", "logoAssetId"];
  if (Object.keys(kit).some(key => !keys.includes(key)) ||
      typeof kit.name !== "string" || !kit.name.trim() || kit.name.length > 80 ||
      !["primary", "accent", "background", "textColor"].every(key =>
        typeof kit[key] === "string" && hex.test(kit[key] as string)) ||
      !fontNames.has(String(kit.fontFamily)) ||
      (kit.logoAssetId !== undefined && (typeof kit.logoAssetId !== "string" || !asset.test(kit.logoAssetId)))) {
    throw new MotionValidationError(["Invalid Brand Kit name, colors, font or workspace image"]);
  }
}
async function brandPath(workspace: string, create = false): Promise<string> {
  return path.join(path.dirname(await motionStorageDir(workspace, create)), "brand-kit.json");
}
export async function getMotionBrandKit(workspace: string): Promise<MotionBrandKit> {
  const filename = await brandPath(workspace);
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try { st = await fs.lstat(filename); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 4096) throw new Error("Invalid Motion Brand Kit file");
  const raw: unknown = JSON.parse(await fs.readFile(filename, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MotionValidationError(["Invalid stored Brand Kit"]);
  const { revision, updatedAt, ...data } = raw as MotionBrandKit;
  validate(data);
  if (!Number.isSafeInteger(revision) || revision < 1 ||
      typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))) {
    throw new MotionValidationError(["Invalid stored Brand Kit revision"]);
  }
  return raw as MotionBrandKit;
}
export async function saveMotionBrandKit(
  workspace: string, baseRevision: number, input: MotionBrandKitInput,
): Promise<MotionBrandKit> {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) {
    throw new MotionValidationError(["Invalid Brand Kit base revision"]);
  }
  validate(input);
  if (input.logoAssetId) await readMotionAsset(workspace, input.logoAssetId);
  const file = await brandPath(workspace, true);
  const lockfile = file + ".lock";
  const lock = await fs.open(lockfile, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") throw new Error("Brand Kit locked by another editor");
    throw error;
  });
  try {
    const current = await getMotionBrandKit(workspace);
    if (current.revision !== baseRevision) {
      throw Object.assign(new Error("Brand Kit revision conflict"), { statusCode: 409 });
    }
    const next: MotionBrandKit = {
      ...input, name: input.name.trim(), revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const tmp = file + "." + crypto.randomBytes(8).toString("hex") + ".tmp";
    try {
      const handle = await fs.open(tmp, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(next, null, 2) + "\n"); await handle.sync(); }
      finally { await handle.close(); }
      await fs.rename(tmp, file);
    } finally { await fs.rm(tmp, { force: true }); }
    return next;
  } finally {
    await lock.close();
    await fs.rm(lockfile, { force: true });
  }
}
