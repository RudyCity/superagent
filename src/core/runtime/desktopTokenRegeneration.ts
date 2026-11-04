/**
 * Tray-only, fixed-shape token rotation adapter.
 *
 * - MCP: rotates ONLY a reloadable Cloudflare MCP OAuth *bootstrap approval*
 *   code, not existing OAuth access/refresh tokens.
 * - Muse (Core-local): rotates the WebSocket bearer in-place, retaining grace.
 *
 * Secrets are copied locally by the owning process. They are never returned
 * through HTTP JSON, the Tray WebView, audit logs, or status snapshots.
 */
export type TrayTokenTarget =
  | {kind:"mcp";port:number;pid:number}
  | {kind:"muse-core";port:number;pid:number};

export function parseTrayTokenTarget(input: unknown): TrayTokenTarget {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid regeneration request");
  }
  const fields = input as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "kind,pid,port" ||
      !["mcp","muse-core"].includes(String(fields.kind)) ||
      typeof fields.port !== "number" || !Number.isSafeInteger(fields.port) ||
      fields.port < 1024 || fields.port > 65535 ||
      typeof fields.pid !== "number" || !Number.isSafeInteger(fields.pid) ||
      fields.pid <= 0 || fields.pid > 4_294_967_295) {
    throw new Error("Invalid or unsupported token regeneration target");
  }
  return fields as TrayTokenTarget;
}

export interface TokenRotationAdapter {
  mcpOwnerPid?(port:number): number | null;
  rotateMcpBootstrap(port:number):Promise<{publicUrl:string;code:string}>;
  copySecretToClipboard(value:string):Promise<boolean>;
  rotateCoreMuse(pid:number):Promise<{copied:boolean}>;
}

const liveAdapter:TokenRotationAdapter = {
  async rotateMcpBootstrap(port) {
    const {regenerateManagedMcpBootstrapCode} =
      await import("./mcpManagedTunnelOwner.js");
    return regenerateManagedMcpBootstrapCode(port);
  },
  async copySecretToClipboard(value) {
    const {copyTextToClipboard} = await import("../remoteAgent/cloudflareTunnel.js");
    return copyTextToClipboard(value);
  },
  async rotateCoreMuse(pid) {
    if (pid !== process.pid) {
      throw new Error("Core Muse owner PID does not match this authenticated Core");
    }
    const {getMuseWatcher} = await import("../remoteAgent/museWatcherRegistry.js");
    const watcher=getMuseWatcher();
    if (!watcher) throw new Error("No Muse Watch owned by this Core");
    return watcher.rotateOwnedWsToken();
  },
};

export async function regenerateTrayToken(
  request:TrayTokenTarget,
  deps?:TokenRotationAdapter
):Promise<{success:true;kind:string;port:number;pid:number;copied:boolean;message:string}> {
  const input=parseTrayTokenTarget(request);
  const adapter=deps ?? liveAdapter;
  if (input.kind === "mcp") {
    // The real lease read is dynamic/import-safe and is performed before any
    // privileged OAuth rotation. A test adapter can supply a frozen fake PID.
    const ownerPid = deps
      ? deps.mcpOwnerPid?.(input.port) ?? null
      : (await import("./mcpManagedTunnelOwner.js")).readManagedMcpTunnelLease(input.port)?.pid ?? null;
    if (ownerPid !== input.pid) {
      throw new Error("MCP managed owner identity changed; regenerate was not attempted");
    }
    const result=await adapter.rotateMcpBootstrap(input.port);
    if (!/^https:\/\//.test(result.publicUrl) ||
        !/^[a-zA-Z0-9_-]{24,128}$/.test(result.code)) {
      throw new Error("Owner returned an invalid OAuth approval-code response");
    }
    const copied=await adapter.copySecretToClipboard(
      "SuperAgent MCP OAuth approval\nEndpoint: " + result.publicUrl +
      "\nOne-time bootstrap code: " + result.code
    );
    return {success:true,kind:input.kind,port:input.port,pid:input.pid,
      copied,
      message:copied
        ? "New MCP OAuth bootstrap approval code copied to OS clipboard. Public URL and existing OAuth grants remain unchanged."
        : "Bootstrap code rotated, but clipboard copy failed. Run the trusted local MCP CLI to regenerate again for a copyable code."};
  }
  const result=await adapter.rotateCoreMuse(input.pid);
  return {success:true,kind:input.kind,port:input.port,pid:input.pid,
    copied:result.copied===true,
    message:result.copied
      ? "Muse bearer token rotated in-place with five-minute grace; private setup copied to OS clipboard."
      : "Muse bearer token rotated, but clipboard copy failed. Recover it from the protected Muse configuration."};
}
