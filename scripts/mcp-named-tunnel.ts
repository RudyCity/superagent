/**
 * Named Cloudflare Tunnel readiness, without any Cloudflare API, DNS or
 * process action. All credential material stays in operator-owned files.
 *
 *   bun scripts/mcp-named-tunnel.ts plan PORT ABSOLUTE_SPEC_JSON
 *   bun scripts/mcp-named-tunnel.ts stage PORT ABSOLUTE_SPEC_JSON --reviewed
 */
import {readMcpNamedTunnelSpec,planMcpNamedTunnel,stageMcpNamedTunnelConfig}
  from "../src/core/runtime/mcpNamedTunnelConfig.js";
const [action,rawPort,specPath,review]=process.argv.slice(2);
const port=Number(rawPort);
if(!["plan","stage"].includes(action??"")||
   !Number.isSafeInteger(port)||port<1024||port>65535||port===9227||port===7888||
   !specPath||action==="plan"&&process.argv.length!==5||
   action==="stage"&&(process.argv.length!==6||review!=="--reviewed"))
  throw Error("MCP_NAMED_USAGE: plan PORT SPEC_JSON | stage PORT SPEC_JSON --reviewed");
const spec=readMcpNamedTunnelSpec(specPath);
const result=action==="plan"?planMcpNamedTunnel(spec,port):
  stageMcpNamedTunnelConfig(spec,port);
console.log(JSON.stringify({
  action,configured:action==="stage",...result,
  next:action==="stage"?
    "Operator must verify cloudflared ingress, Cloudflare DNS and remote OAuth before a reviewed start.":
    "Only stage after reviewing hostname, UUID, credential provenance and proposed target port.",
  noTunnelRestart:true,noDnsMutation:true,noRuntimeMutation:true,
},null,2));
