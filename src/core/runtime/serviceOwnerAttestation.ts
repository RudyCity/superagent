/** Strictly read-only owner/build parity summary. No source, PID, or HTTP
 * status is allowed to stand in for a missing installed artifact digest. */
import type {ServiceStatus} from "./serviceManager.js";
const sha=(x:unknown):string|null=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)?x:null;
export function summarizeServiceOwnerAttestation(rows:ReadonlyArray<ServiceStatus>) {
  const services=rows.map(s=>{
    const d=s.details??{};
    const owner=s.ownershipVerified===true && Number.isSafeInteger(s.ownerPid) &&
      Number(s.ownerPid)>0;
    const runtimeDigest=sha(s.service==="mcp"?d.backendReleaseDigest:
      s.service==="tray"?d.installedReleaseDigest:d.activeBuildDigest);
    const sourceDigest=sha(d.sourceBuildDigest);
    const webviewDigest=s.service==="tray"?sha(d.webviewBundleDigest):null;
    const sourceRevision=typeof d.sourceRevision==="string"&&
      /^[a-f0-9]{40}$/.test(d.sourceRevision)?d.sourceRevision:null;
    const loadedSourceRevision=typeof d.loadedSourceRevision==="string"&&
      /^[a-f0-9]{40}$/.test(d.loadedSourceRevision)?d.loadedSourceRevision:null;
    const code=s.state==="inactive"?"NOT_RUNNING":
      !owner?"HOST_OWNER_UNVERIFIED":
      d.buildFresh===false || d.versionDrift===true ||
      (runtimeDigest!==null&&sourceDigest!==null&&runtimeDigest!==sourceDigest)
        ?"SOURCE_CHANGED_NOT_LOADED":
      runtimeDigest===null||sourceDigest===null?"RUNTIME_DIGEST_UNAVAILABLE":
      s.service==="tray"&&webviewDigest===null?"WEBVIEW_DIGEST_UNAVAILABLE":
      s.service==="tray"&&(!sourceRevision||!loadedSourceRevision)
        ?"SOURCE_REVISION_UNAVAILABLE":
      s.service==="tray"&&sourceRevision!==loadedSourceRevision
        ?"SOURCE_CHANGED_NOT_LOADED":
      "OWNER_BUILD_ATTESTED";
    return {service:s.service,port:s.port??null,state:s.state,
      owner:{verified:owner,pid:owner?s.ownerPid:null},
      build:{runtimeDigest,sourceDigest,webviewDigest,
        sourceRevision,loadedSourceRevision,
        sourceVersion:typeof d.sourceVersion==="string"?d.sourceVersion:null,
        runtimeVersion:typeof d.runtimeVersion==="string"?d.runtimeVersion:null},
      code,ready:code==="OWNER_BUILD_ATTESTED",
      nextStep:code==="OWNER_BUILD_ATTESTED"?"Verify installed native signer and runtime tests":
        code==="SOURCE_CHANGED_NOT_LOADED"?"Obtain verified owner-approved reload plan":
        code==="HOST_OWNER_UNVERIFIED"?"Verify process birth, listener and supervisor":
        code==="NOT_RUNNING"?"Inspect managed owner; do not adopt legacy process":
        code==="WEBVIEW_DIGEST_UNAVAILABLE"?"Attest installed WebView resource digest":
        code==="SOURCE_REVISION_UNAVAILABLE"?"Build with Git revision and independently identify checkout HEAD":
        "Obtain exact source and loaded build digests",
    };
  });
  return {action:"owner_status",readOnly:true,observedAt:Date.now(),services,
    ready:services.length>0&&services.every(x=>x.ready),
    note:"Read-only evidence. No raw paths, authorization, or build parity inferred from responsive HTTP or version."};
}
