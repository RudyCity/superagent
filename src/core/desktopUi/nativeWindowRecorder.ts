/**
 * Host-approved exact native window recording.
 * A fresh native Tray recording dialog (separate from preview approval)
 * must sign the exact window, project path, preset and preview capability.
 * No monitor-wide fallback, remote video endpoint or input permission.
 */
import { createHash } from "node:crypto";
import { nativeWindowPreviewManager } from "./livePreview.js";
import { startCdpSessionArchive, type CdpRecordingPreset } from "../tools/chromeCdpSessionArchive.js";

type PinnedWindow=NonNullable<ReturnType<typeof nativeWindowPreviewManager.getActiveSession>>;
const presetValues = new Set(["compact","standard","detail"]);
const allowedKeys=new Set([
  "action","projectDirectory","previewToken","pid","nativeId",
  "expectedTitle","expectedApplication","expectedBounds",
  "videoPreset","consent",
]);
const exact=(a:PinnedWindow,b:PinnedWindow)=>
  a.pid===b.pid && a.nativeId===b.nativeId &&
  a.title===b.title && a.application===b.application &&
  a.bounds.x===b.bounds.x && a.bounds.y===b.bounds.y &&
  a.bounds.width===b.bounds.width && a.bounds.height===b.bounds.height;

export function inspectNativeWindowRecordingPreview(previewToken: unknown) {
  if(typeof previewToken!=="string" || !/^[a-f0-9]{64}$/.test(previewToken))
    throw Error("Valid exact-window preview capability required.");
  const pinned=nativeWindowPreviewManager.getActiveSession(previewToken);
  if(!pinned)throw Error("No active, approved native preview.");
  return pinned;
}
export async function startApprovedNativeWindowRecording(raw: unknown) {
  if(!raw || typeof raw!=="object" || Array.isArray(raw))
    throw Error("Invalid native recording request.");
  const body=raw as Record<string,unknown>;
  if(Object.keys(body).some(key=>!allowedKeys.has(key)) ||
     body.consent!==true ||
     typeof body.projectDirectory!=="string" ||
     typeof body.previewToken!=="string" ||
     !presetValues.has(String(body.videoPreset)))
    throw Error("Separate native recording approval required.");
  const previewToken=body.previewToken;
  const pinned=inspectNativeWindowRecordingPreview(previewToken);
  const bounds=body.expectedBounds;
  if(!bounds || typeof bounds!=="object" || Array.isArray(bounds))
    throw Error("Exact approved window bounds required.");
  const proposal={
    pid:body.pid,nativeId:body.nativeId,
    title:body.expectedTitle,application:body.expectedApplication,
    bounds:bounds as PinnedWindow["bounds"],
  } as PinnedWindow;
  if(!exact(pinned,proposal))throw Error("Recording window changed since approval.");
  const scope={
    targetKey:"native:"+pinned.pid+":"+pinned.nativeId,
    actorId:"local-tray-native-recording",
    generation:createHash("sha256").update(previewToken).digest("hex").slice(0,40),
  };
  const checkLease=async() => {
    const current=nativeWindowPreviewManager.getActiveSession(previewToken);
    return !!current && exact(current,pinned);
  };
  const captureFrame=async():Promise<string> => {
    for(let attempt=0;attempt<16;attempt++){
      if(!(await checkLease()))throw Error("Native preview ownership changed.");
      try {
        const frame=await nativeWindowPreviewManager.frame({
          token:previewToken,codec:"jpeg",maxWidth:960,quality:66,
        });
        if(frame.unchanged!==false || frame.format!=="jpeg" ||
           typeof frame.jpeg!=="string")throw Error("Native frame unavailable.");
        if(!(await checkLease()))throw Error("Native preview was revoked.");
        return frame.jpeg;
      } catch(error){
        if(/rate limited or busy/i.test(String((error as Error)?.message)) &&
            attempt<15){
          await new Promise<void>(done=>setTimeout(done,32));
          continue;
        }
        throw error;
      }
    }
    throw Error("Native preview capture unavailable.");
  };
  return startCdpSessionArchive(scope,{
    projectDirectory:body.projectDirectory,
    confirmSensitiveVideo:true,
    videoPreset:body.videoPreset as CdpRecordingPreset,
    captureFrame,checkLease,
  });
}
