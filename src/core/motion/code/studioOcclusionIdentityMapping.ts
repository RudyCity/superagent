import { MotionValidationError } from "../schema/validation.js";

export interface StudioOcclusionObject {
  x:number; y:number; width:number; height:number; color:string;
}
export interface StudioOcclusionMapping {
  beforeToAfter: number[];
  maxColorDelta: number;
  maxAreaRatio: number;
  maxCenterDisplacement: number;
}
const rgb=(color:string): number[] => {
  if(!/^#[0-9a-fA-F]{6}$/.test(color)) throw new MotionValidationError(["Invalid occlusion object color"]);
  return [1,3,5].map(i=>parseInt(color.slice(i,i+2),16));
};
/** User-provided permutation; no guessed assignments and no hidden-pixel inference.
 * Numbered labels are local to two evidence frames, never global object IDs.
 */
export function validateStudioOcclusionMapping(
  before:readonly StudioOcclusionObject[],
  after:readonly StudioOcclusionObject[],
  mapping:readonly number[],
  width:number,height:number,
): StudioOcclusionMapping {
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<32||height<32||
    before.length<2||before.length>4||after.length!==before.length ||
    !Array.isArray(mapping)||mapping.length!==before.length||
    mapping.some(n=>!Number.isSafeInteger(n)||n<0||n>=after.length) ||
    new Set(mapping).size!==mapping.length)
    throw new MotionValidationError(["Select a distinct after-object for every before-object"]);
  let maxColorDelta=0,maxAreaRatio=0,maxCenterDisplacement=0;
  before.forEach((first,i)=>{
    const second=after[mapping[i]];
    const a=rgb(first.color),b=rgb(second.color);
    const colorDiff=Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2]);
    const area=(second.width*second.height)/(first.width*first.height);
    const movement=Math.hypot(
      (first.x+first.width/2-second.x-second.width/2)/width,
      (first.y+first.height/2-second.y-second.height/2)/height,
    );
    if (![area,movement,colorDiff].every(Number.isFinite) ||
        first.width<5||first.height<5||second.width<5||second.height<5||
        area<.65||area>1.5 || colorDiff>75 || movement>.34)
      throw new MotionValidationError([
        "Identity mapping conflicts with visible color, size or displacement for before-object "+(i+1),
      ]);
    maxColorDelta=Math.max(maxColorDelta,colorDiff);
    maxAreaRatio=Math.max(maxAreaRatio,Math.max(area,1/area));
    maxCenterDisplacement=Math.max(maxCenterDisplacement,movement);
  });
  return {
    beforeToAfter:[...mapping],
    maxColorDelta:Number(maxColorDelta.toFixed(2)),
    maxAreaRatio:Number(maxAreaRatio.toFixed(3)),
    maxCenterDisplacement:Number(maxCenterDisplacement.toFixed(4)),
  };
}
