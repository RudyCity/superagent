/**
 * Official release CLI. Read-only discovery or explicit downloaded-and-staged
 * backend. Never installs/activates the backend or restarts any service.
 *
 * bun scripts/stage-mcp-backend-release.ts --check [--tag=vX.Y.Z-rc.N]
 * bun scripts/stage-mcp-backend-release.ts --stage --tag=vX.Y.Z-rc.N
 */
import {resolveGithubBackendCandidate,downloadAndStageGithubBackend} from "../src/core/runtime/mcpBackendGithubRelease.js";
const args=process.argv.slice(2);
const action=args.includes("--check")?"check":args.includes("--stage")?"stage":"";
const flags=args.filter(a=>a==="--check"||a==="--stage");
const tagFlag=args.filter(a=>a.startsWith("--tag="));
if(flags.length!==1||tagFlag.length>1||args.length!==flags.length+tagFlag.length||
   !action||(action==="stage"&&tagFlag.length!==1))
  throw Error("MCP_BACKEND_STAGE_USAGE: --check [--tag=vX.Y.Z-rc.N] | --stage --tag=vX.Y.Z-rc.N");
const candidate=await resolveGithubBackendCandidate(tagFlag[0]?.slice(6));
console.log(JSON.stringify({action:"verified",tag:candidate.candidate.tag,
  asset:candidate.candidate.asset.name,bytes:candidate.candidate.asset.size,
  sourceCommit:candidate.sourceCommit,sha256:candidate.checksum,
  runtimeChanged:false},null,2));
if(action==="stage"){
  const result=await downloadAndStageGithubBackend(candidate);
  console.log(JSON.stringify({action:"staged",...result,runtimeChanged:false,
    next:"Review: bun scripts/mcp-backend-release.ts plan PORT DIGEST"},null,2));
}
