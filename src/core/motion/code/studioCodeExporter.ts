import type { MotionLayer, MotionProject, MotionTrack } from "../schema/types.js";
import { validateMotionProject } from "../schema/validation.js";

export type StudioCodeTrigger = "autoplay" | "scroll" | "click" | "hover";

const escapeXml = (value: string): string => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const safeJson = (value: unknown) => JSON.stringify(value)
  .replace(/</g, "\\u003c").replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026").replace(/\\u2028/g, "\\u2028")
  .replace(/\\u2029/g, "\\u2029");

export function renderStudioCodeHtml(project: MotionProject, trigger: StudioCodeTrigger = "autoplay"): string {
  validateMotionProject(project);
  if (!["autoplay", "scroll", "click", "hover"].includes(trigger)) {
    throw new Error("Unsupported Studio to Code trigger");
  }
  const c = project.composition;
  // Fail closed: video/image/audio are not vector-code equivalents.
  const unsupported = c.layers.filter(l => l.kind === "image" || l.kind === "video");
  if (unsupported.length) throw new Error(
    "Studio to Code requires vector/text-only layers; raster/video: " +
    unsupported.map(l => l.id).join(", "));
  if (c.audio || c.audioTracks?.length) throw new Error(
    "Studio to Code does not yet export audio; remove or separately embed audio tracks");
  const layers = c.layers.map((layer: MotionLayer, index) => {
    const common = 'data-studio-id="' + escapeXml(layer.id) +
      '" data-studio-index="' + index + '"';
    const content = layer.kind === "rect"
      ? '<rect width="' + layer.width + '" height="' + layer.height +
        '" rx="' + (layer.cornerRadius ?? 0) + '" fill="' + escapeXml(layer.fill) + '"/>'
      : layer.kind === "text"
      ? '<text x="0" y="' + layer.fontSize + '" font-size="' + layer.fontSize +
        '" font-family="' + escapeXml(layer.fontFamily) +
        '" fill="' + escapeXml(layer.fill) + '">' + escapeXml(layer.text) + '</text>'
      : layer.kind === "path"
      ? '<path d="' + escapeXml(layer.d) + '" fill="' + escapeXml(layer.fill) +
        '" fill-rule="' + (layer.fillRule ?? "nonzero") + '"' +
        (layer.stroke ? ' stroke="' + escapeXml(layer.stroke) + '"' : "") +
        (layer.strokeWidth !== undefined ? ' stroke-width="' + layer.strokeWidth + '"' : "") +
        (layer.strokeDasharray?.length ? ' stroke-dasharray="' + layer.strokeDasharray.join(" ") + '"' : "") +
        ' stroke-dashoffset="' + (layer.strokeDashoffset ?? 0) + '"/>'
      : "";
    return '<g ' + common + '>' + content + '</g>';
  }).join("\n      ");
  const tracks = c.layers.map(layer => ({
    id: layer.id, x: layer.x, y: layer.y, rotation: layer.rotation,
    opacity: layer.opacity, scale: layer.scale ?? 1,
    scaleX: layer.scaleX ?? layer.scale ?? 1,
    scaleY: layer.scaleY ?? layer.scale ?? 1,
    strokeDashoffset: layer.kind === "path" ? layer.strokeDashoffset ?? 0 : 0,
    tracks: layer.tracks satisfies MotionTrack[],
  }));
  const serialized = safeJson({
    trigger, fps: c.fps.numerator / c.fps.denominator,
    duration: c.durationFrames / (c.fps.numerator / c.fps.denominator), layers: tracks,
  });
  const scrollScript = trigger === "scroll"
    ? '<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/ScrollTrigger.min.js"></script>'
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(project.name)} · SuperAgent Studio to Code</title>
<style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#090d15;color:#e9efff;font:14px system-ui,sans-serif}
main{max-width:1100px;margin:auto;padding:clamp(12px,3vw,36px)}
h1{font-size:clamp(17px,2.4vw,25px);margin:0 0 14px;font-weight:650}
#studio-stage{display:block;width:100%;height:auto;background:${escapeXml(c.background)};border:1px solid #303b50;border-radius:16px}
#studio-stage:focus-visible{outline:3px solid #6bf}
.controls{display:flex;align-items:center;gap:12px;padding:16px 0;color:#b7c3d9}
button{padding:8px 14px;border:1px solid #5d7399;border-radius:8px;background:#18253b;color:#fff;cursor:pointer}
button:focus-visible{outline:2px solid #6bf}
#studio-progress{flex:1;accent-color:#6bf}
#studio-scroll-space{height:120vh;display:none}
body.scroll #studio-scroll-space{display:block}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
</style>
</head>
<body class="${trigger}">
<main>
<h1>${escapeXml(project.name)}</h1>
<svg id="studio-stage" viewBox="0 0 ${c.width} ${c.height}" role="img"
  aria-label="${escapeXml(project.name)}" tabindex="0" xmlns="http://www.w3.org/2000/svg">
  <rect width="${c.width}" height="${c.height}" fill="${escapeXml(c.background)}"/>
  ${layers}
</svg>
<div class="controls">
  <button id="studio-toggle" type="button">Play / Pause</button>
  <button id="studio-replay" type="button">Replay</button>
  <input id="studio-progress" type="range" min="0" max="1000" value="0" aria-label="Animation timeline">
  <output id="studio-time">0.0s</output>
</div>
<p id="studio-notice" role="status">SuperAgent Studio · editable SVG / GSAP source · ${trigger}</p>
<div id="studio-scroll-space" aria-hidden="true"></div>
</main>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
${scrollScript}
<script>
"use strict";
(function(){
const scene=${serialized};
const notice=document.getElementById("studio-notice");
if(!window.gsap){notice.textContent="GSAP unavailable: connect to the internet or host GSAP locally.";return}
const gsap=window.gsap, svg=document.getElementById("studio-stage");
const progress=document.getElementById("studio-progress"), time=document.getElementById("studio-time");
const easings={
 linear:t=>t,step:t=>0,easeIn:t=>t*t,easeOut:t=>t*(2-t),
 easeInOut:t=>t*t*(3-2*t),
 easeOutCubic:t=>1-Math.pow(1-t,3),easeOutQuart:t=>1-Math.pow(1-t,4),
 easeOutExpo:t=>t===1?1:1-Math.pow(2,-10*t),
 apple:t=>1-Math.pow(1-t,3.8),
 spring:t=>1-Math.exp(-9*t*.5)*Math.cos(4.2*t*Math.PI),
 easeOutBack:t=>{const u=t-1;return 1+2.70158*u*u*u+1.70158*u*u},
 bounce:t=>{const n=7.5625,d=2.75;let x=t;
  if(x<1/d)return n*x*x;if(x<2/d){x-=1.5/d;return n*x*x+.75}
  if(x<2.5/d){x-=2.25/d;return n*x*x+.9375}
  x-=2.625/d;return n*x*x+.984375}
};
for(const [key,ease] of Object.entries(easings))gsap.registerEase("studio-"+key,ease);
const tl=gsap.timeline({paused:true,onUpdate(){
 const t=tl.time(), duration=scene.duration;
 progress.value=String(Math.round(t/duration*1000));
 time.textContent=t.toFixed(1)+"s / "+duration.toFixed(1)+"s";
}});
const props=["x","y","rotation","opacity","scale","scaleX","scaleY"];
for(let i=0;i<scene.layers.length;i++){
 const layer=scene.layers[i], node=svg.querySelector('[data-studio-index="'+i+'"]');
 if(!node)continue;
 gsap.set(node,{x:layer.x,y:layer.y,rotation:layer.rotation,opacity:layer.opacity,
   scaleX:layer.scaleX,scaleY:layer.scaleY,transformOrigin:"0 0"});
 const path=node.querySelector("path");
 if(path)gsap.set(path,{attr:{"stroke-dashoffset":layer.strokeDashoffset}});
 for(const track of layer.tracks){
   const keys=track.keyframes, prop=track.property;
   const target=prop==="strokeDashoffset"?path:node;
   if(!target || (prop!=="strokeDashoffset"&&!props.includes(prop)))continue;
   const attr=prop==="strokeDashoffset";
   const setVars=val=>attr?{attr:{"stroke-dashoffset":val}}:prop==="scale"?{scaleX:val,scaleY:val}:{[prop]:val};
   tl.set(target,setVars(keys[0].value),keys[0].frame/scene.fps);
   for(let j=1;j<keys.length;j++){
     const left=keys[j-1],right=keys[j],start=left.frame/scene.fps;
     tl.to(target,{...setVars(right.value),duration:(right.frame-left.frame)/scene.fps,
       ease:"studio-"+(left.easing||"linear"),immediateRender:false},start);
   }
 }
}
tl.to({}, {duration:scene.duration},0);
document.getElementById("studio-toggle").addEventListener("click",()=>tl.paused()?tl.play():tl.pause());
document.getElementById("studio-replay").addEventListener("click",()=>tl.restart());
progress.addEventListener("input",()=>tl.pause().time(Number(progress.value)/1000*scene.duration));
if(window.matchMedia("(prefers-reduced-motion: reduce)").matches){
 tl.progress(1);notice.textContent="Reduced motion: final frame shown. Controls remain available.";
}else if(scene.trigger==="autoplay"){tl.play()}
else if(scene.trigger==="click"){
 svg.addEventListener("click",()=>tl.restart());
 svg.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();tl.restart()}});
}else if(scene.trigger==="hover"){
 svg.addEventListener("mouseenter",()=>tl.restart());
 svg.addEventListener("mouseleave",()=>tl.pause());
 svg.addEventListener("focus",()=>tl.restart());
}else if(scene.trigger==="scroll"){
 if(!window.ScrollTrigger){notice.textContent="ScrollTrigger unavailable; manual controls still work.";return}
 gsap.registerPlugin(window.ScrollTrigger);
 window.ScrollTrigger.create({trigger:svg,start:"top center",end:"+=100%",scrub:true,
   animation:tl, invalidateOnRefresh:true});
}
})();
</script>
</body></html>`;
}
