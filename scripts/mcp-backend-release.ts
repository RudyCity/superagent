/**
 * Private CLI: side-by-side MCP backend release handoff.
 * This never restarts the owner, Core or cloudflared, and never replays calls.
 *
 * Usage:
 *   bun scripts/mcp-backend-release.ts plan PORT BUILD_SHA256
 *   bun scripts/mcp-backend-release.ts activate PORT BUILD_SHA256 OWNER_PID BACKEND_PID PUBLIC_URL --reviewed
 */
import { readManagedMcpTunnelLease, verifyManagedOwnerIdentity } from "../src/core/runtime/mcpManagedTunnelOwner.js";
import { getMcpStateFile, readMcpStateFile } from "../src/core/mcp/mcpTunnel.js";
import { verifyMcpBackendRelease } from "../src/core/runtime/mcpBackendReleasePolicy.js";

type Reply = Record<string, unknown>;
const [action, portText, digest, ownerText, backendText, expectedUrl, review] = process.argv.slice(2);
const port = Number(portText);
if (!["plan", "activate"].includes(action ?? "") ||
    !Number.isSafeInteger(port) || port < 1024 || port > 65535 ||
    !/^[a-f0-9]{64}$/.test(digest ?? "")) {
  throw new Error("MCP_RELEASE_USAGE: plan PORT DIGEST | activate PORT DIGEST OWNER_PID BACKEND_PID PUBLIC_URL --reviewed");
}
if (action === "activate" && (review !== "--reviewed" ||
    !Number.isSafeInteger(Number(ownerText)) || !Number.isSafeInteger(Number(backendText)) ||
    !expectedUrl?.startsWith("https://") || !expectedUrl.endsWith("/mcp"))) {
  throw new Error("MCP_RELEASE_EXPLICIT_REVIEW_REQUIRED");
}
const lease = readManagedMcpTunnelLease(port);
if (!lease) throw new Error("MCP_RELEASE_OWNER_NOT_REGISTERED");
await verifyManagedOwnerIdentity(lease);
const state = readMcpStateFile(getMcpStateFile(port));
if (!state || state.pid !== lease.pid || !state.publicUrl)
  throw new Error("MCP_RELEASE_OWNER_STATE_UNVERIFIED");
if (action === "activate" &&
    (lease.pid !== Number(ownerText) || state.publicUrl !== expectedUrl))
  throw new Error("MCP_RELEASE_OWNER_OR_URL_CHANGED");
// Validate the immutable, address-by-content candidate before requesting either plan or activation.
const candidate = verifyMcpBackendRelease(digest!);
const base = "http://127.0.0.1:" + port + "/_internal/owner/backend/";
async function call(endpoint: string, method: "GET"|"POST"):Promise<Reply> {
  const response = await fetch(base + endpoint, {
    method,
    headers: {Authorization: "Bearer " + lease!.nonce, Accept:"application/json"},
    signal: AbortSignal.timeout(method === "POST" ? 70_000 : 8_000),
  });
  const body = await response.json() as Reply;
  if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : "MCP_RELEASE_CONTROL_REJECTED");
  return body;
}
if (action === "plan") {
  const plan = await call("plan?digest=" + candidate.digest, "GET");
  if (plan.ownerPid !== lease.pid || plan.digest !== candidate.digest ||
      plan.publicUrl !== state.publicUrl || plan.noTunnelRestart !== true ||
      !Number.isSafeInteger(plan.expectedBackendPid))
    throw new Error("MCP_RELEASE_PLAN_UNATTESTED");
  console.log(JSON.stringify({action:"plan",...plan,changed:false},null,2));
} else {
  const result = await call("activate?"+new URLSearchParams({
    digest:candidate.digest,
    expectedBackendPid:backendText!,
    expectedPublicUrl:expectedUrl!,
    reviewed:"1",
  }),"POST");
  const after = readMcpStateFile(getMcpStateFile(port));
  await verifyManagedOwnerIdentity(lease);
  if (!after || after.pid !== lease.pid || after.publicUrl !== state.publicUrl ||
      result.success !== true || result.url !== state.publicUrl ||
      result.releaseDigest !== candidate.digest ||
      result.previousPid !== Number(backendText) ||
      !Number.isSafeInteger(result.pid) || result.pid === Number(backendText))
    throw new Error("MCP_RELEASE_POSTCHECK_FAILED: outcome uncertain, do not replay");
  console.log(JSON.stringify({action:"activate",changed:true,ownerPid:lease.pid,...result},null,2));
}
