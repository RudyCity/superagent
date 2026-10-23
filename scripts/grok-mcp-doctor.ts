/** Read-only diagnostics for a Grok.com custom MCP endpoint. Never prints secrets. */
const raw = process.argv[2];
if (!raw) { console.error("Usage: bun scripts/grok-mcp-doctor.ts https://public-host/mcp"); process.exit(2); }
let endpoint: URL;
try {
  endpoint = new URL(raw);
  if (endpoint.protocol !== "https:" || endpoint.pathname !== "/mcp" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("invalid endpoint");
} catch { console.error("Expected a public HTTPS URL ending in /mcp, without credentials or query parameters."); process.exit(2); }
const checks: Array<{ name: string; status?: number; ok: boolean; detail?: string }> = [];
async function check(name: string, path: string, method = "GET", headers: Record<string, string> = {}, body?: string) {
  try {
    const response = await fetch(new URL(path, endpoint.origin), { method, headers, body, signal: AbortSignal.timeout(10000), redirect: "manual" });
    const json = method === "HEAD" ? null : await response.json().catch(() => null);
    const ok = name === "MCP authentication challenge" ? response.status === 401 && !!response.headers.get("www-authenticate") : response.ok;
    checks.push({ name, status: response.status, ok, detail: ok ? "OK" : "Check endpoint configuration" });
    return json;
  } catch { checks.push({ name, ok: false, detail: "Request failed or timed out" }); return null; }
}
const resource = await check("OAuth protected resource", "/.well-known/oauth-protected-resource");
const auth = await check("OAuth authorization server", "/.well-known/oauth-authorization-server");
await check("MCP authentication challenge", "/mcp", "HEAD");
const metadataOk = resource?.resource === endpoint.href && Array.isArray(resource?.authorization_servers) && auth?.issuer === endpoint.origin && !!auth?.authorization_endpoint && !!auth?.token_endpoint && !!auth?.registration_endpoint;
checks.push({ name: "OAuth metadata consistency", ok: !!metadataOk, detail: metadataOk ? "OK" : "Issuer, resource or endpoints mismatch" });
console.log(JSON.stringify({ endpoint: endpoint.href, checks }, null, 2));
if (checks.some(c => !c.ok)) process.exitCode = 1;
