/** Strictly read-only owner/build parity summary. No source, PID, or HTTP
 * status is allowed to stand in for a missing installed artifact digest. */
import type {ServiceStatus} from "./serviceManager.js";
import {readProcessStartIdentity} from "../tools/cliBridgeProcessIdentity.js";
const sha=(x:unknown):string|null=>typeof x==="string"&&/^[a-f0-9]{64}$/.test(x)?x:null;
const positive=(x:unknown):number|null=>Number.isSafeInteger(x)&&Number(x)>0?Number(x):null;
const birth=(x:unknown):string|null=>typeof x==="string"&&
  x.length<=120&&/^(?:win:\d{15,20}|linux:[a-f0-9-]{36}:\d+)$/.test(x)?x:null;

/** A fresh OS fingerprint is evidence of process birth, never owner/control authority. */
export async function observeVerifiedServiceProcessBirth(
  rows:ReadonlyArray<ServiceStatus>,readBirth=readProcessStartIdentity,
):Promise<ServiceStatus[]> {
  return Promise.all(rows.map(async row=>{
    if(!row.ownershipVerified||positive(row.ownerPid)===null)return row;
    let identity:string|null=null;
    try { identity=await readBirth(row.ownerPid); }
    catch { /* OS observation failure is unknown evidence, never owner failure or authority. */ }
    return {...row,details:{...row.details,observedProcessBirthIdentity:birth(identity)}};
  }));
}
export function summarizeServiceOwnerAttestation(rows:ReadonlyArray<ServiceStatus>) {
  const services=rows.map(s=>{
    const d=s.details??{};
    const owner=s.ownershipVerified===true && Number.isSafeInteger(s.ownerPid) &&
      Number(s.ownerPid)>0;
    const processBirth=owner?birth(d.observedProcessBirthIdentity):null;
    const supervisorVerified=owner&&s.service==="core"&&d.supervisorLifecycleVersion===2;
    const runtimeDigest=sha(s.service==="mcp"?d.backendReleaseDigest:
      s.service==="tray"?d.installedReleaseDigest:d.activeBuildDigest);
    const sourceDigest=sha(d.sourceBuildDigest);
    const webviewDigest=s.service==="tray"?sha(d.webviewBundleDigest):null;
    const sourceRevision=typeof d.sourceRevision==="string"&&
      /^[a-f0-9]{40}$/.test(d.sourceRevision)?d.sourceRevision:null;
    const loadedSourceRevision=typeof d.loadedSourceRevision==="string"&&
      /^[a-f0-9]{40}$/.test(d.loadedSourceRevision)?d.loadedSourceRevision:null;
    // The active release digest describes the immutable release slot. A
    // workspace Cargo target is a separate local build and must be checked by
    // its embedded Git revision instead of being compared to that slot hash.
    const runtimeKind=s.service==="tray"&&
      ["active-release","previous-release","workspace-build","trusted-installed"].includes(String(d.runtimeKind))
        ?String(d.runtimeKind):s.service==="tray"?"active-release":null;
    const compareReleaseDigest=s.service!=="tray"||runtimeKind!=="workspace-build";
    const digestMismatch=compareReleaseDigest&&runtimeDigest!==null&&
      sourceDigest!==null&&runtimeDigest!==sourceDigest;
    const digestUnavailable=runtimeDigest===null||
      (compareReleaseDigest&&sourceDigest===null);
    const code=s.state==="inactive"?"NOT_RUNNING":
      !owner?"HOST_OWNER_UNVERIFIED":
      d.buildFresh===false || d.versionDrift===true || digestMismatch
        ?"SOURCE_CHANGED_NOT_LOADED":
      digestUnavailable?"RUNTIME_DIGEST_UNAVAILABLE":
      s.service==="tray"&&webviewDigest===null?"WEBVIEW_DIGEST_UNAVAILABLE":
      s.service==="tray"&&(!sourceRevision||!loadedSourceRevision)
        ?"SOURCE_REVISION_UNAVAILABLE":
      s.service==="tray"&&sourceRevision!==loadedSourceRevision
        ?"SOURCE_CHANGED_NOT_LOADED":
      "OWNER_BUILD_ATTESTED";
    return {service:s.service,port:s.port??null,state:s.state,
      owner:{verified:owner,pid:owner?s.ownerPid:null,
        processBirth:{state:processBirth?"observed":"unknown",identity:processBirth,observationOnly:true}},
      supervisor:{state:supervisorVerified?"authenticated":"unknown",
        safeLifecycleVersion:supervisorVerified?2:null},
      nativeSigner:{state:"unknown",reasonCode:"NATIVE_SIGNER_NOT_ATTESTED"},
      build:{runtimeDigest,sourceDigest,webviewDigest,runtimeKind,
        worker:{pid:owner&&s.service==="core"?positive(d.activeWorkerPid):null,
          since:owner&&s.service==="core"?positive(d.activeWorkerSince):null,
          mode:owner&&s.service==="core"&&(d.activeWorkerBuildMode==="source"||d.activeWorkerBuildMode==="compiled")
            ?d.activeWorkerBuildMode:null},
        sourceRevision,loadedSourceRevision,
        sourceVersion:typeof d.sourceVersion==="string"?d.sourceVersion:null,
        runtimeVersion:typeof d.runtimeVersion==="string"?d.runtimeVersion:null},
      code,ready:code==="OWNER_BUILD_ATTESTED",
      evidenceComplete:false,mutationAuthorized:false,releaseCertified:false,
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
    evidenceComplete:false,
    ready:services.length>0&&services.every(x=>x.ready),
    note:"Read-only evidence. No raw paths, authorization, or build parity inferred from responsive HTTP or version."};
}
