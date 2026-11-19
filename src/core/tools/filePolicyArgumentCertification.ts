/**
 * Pure argument certification helpers shared by the host file gate and bounded
 * exact-file search. Keep these free of registry/runtime imports so validation
 * cannot be lost through a module cycle or test mock.
 */
export type FilePolicyArgs = Record<string, unknown>;

export function certifiedExplicitGrepSearchArgs(args: FilePolicyArgs | undefined): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const allowed = ["filePaths","query","caseSensitive","isRegex","offset","limit",
    "workspace","cwd","projectId"];
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (!Array.isArray(args.filePaths) || args.filePaths.length < 1 || args.filePaths.length > 50 ||
      args.filePaths.some(item => typeof item !== "string" || !item.trim() || item.length > 2048))
    return false;
  if (typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) return false;
  if (args.isRegex !== undefined && args.isRegex !== false) return false;
  if (args.caseSensitive !== undefined && typeof args.caseSensitive !== "boolean") return false;
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) ||
      Number(args.offset) < 0 || Number(args.offset) > 1_000_000)) return false;
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) ||
      Number(args.limit) < 1 || Number(args.limit) > 200)) return false;
  for (const key of ["workspace","cwd","projectId"])
    if (args[key] !== undefined && (typeof args[key] !== "string" || !String(args[key]).trim()))
      return false;
  return true;
}
