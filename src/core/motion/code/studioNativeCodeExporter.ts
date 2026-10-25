import type { MotionProject } from "../schema/types.js";
import { renderStudioCodeHtml, type StudioCodeTrigger } from "./studioCodeExporter.js";
import { validateMotionProject } from "../schema/validation.js";

/**
 * Standalone first-party Studio player.
 * Does not load GSAP, npm, CDN, or other third-party code.
 * Reuses the existing validated SVG document construction; strips its old
 * optional GSAP runtime before appending our own native frame evaluator.
 */
export function renderStudioNativeHtml(project: MotionProject, trigger: StudioCodeTrigger = "autoplay"): string {
  validateMotionProject(project);
  const graph = project.composition.interactionGraph ?? null;
  const hasScroll = graph?.bindings.some(rule => rule.event === "scroll") ?? false;
  const legacy = renderStudioCodeHtml(project, hasScroll ? "scroll" : trigger);
  const delimiter = '<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>';
  const pos = legacy.indexOf(delimiter);
  if (pos < 0 || legacy.indexOf(delimiter, pos + 1) >= 0)
    throw new Error("Studio HTML shell runtime boundary changed; native export aborted");
  const prefix = legacy.slice(0, pos)
    .replace("editable SVG / GSAP source", "editable SVG / native browser source")
    .replace(" · SuperAgent Studio to Code", " · SuperAgent Studio to Code (offline)");
  const payload = project.composition.layers.map(layer => ({
    id: layer.id, x: layer.x, y: layer.y, rotation: layer.rotation,
    opacity: layer.opacity, scaleX: layer.scaleX ?? layer.scale ?? 1,
    scaleY: layer.scaleY ?? layer.scale ?? 1,
    strokeDashoffset: layer.kind === "path" ? layer.strokeDashoffset ?? 0 : 0,
    tracks: layer.tracks,
  }));
  const scene = JSON.stringify({
    trigger,
    fps: project.composition.fps.numerator / project.composition.fps.denominator,
    durationFrames: project.composition.durationFrames,
    graph,
    layers: payload,
  }).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return prefix + `<script>
"use strict";
(function () {
  const scene = ${scene};
  const svg = document.getElementById("studio-stage");
  const progress = document.getElementById("studio-progress");
  const timeLabel = document.getElementById("studio-time");
  const notice = document.getElementById("studio-notice");
  const maxTime = scene.durationFrames / scene.fps;
  const elements = scene.layers.map((layer, i) => ({
    layer,
    node: svg.querySelector('[data-studio-index="' + i + '"]'),
  }));
  const clamp = (v, a, b) => Math.max(a, Math.min(v, b));
  const easings = {
    linear:t=>t, step:t=>0, easeIn:t=>t*t, easeOut:t=>t*(2-t),
    easeInOut:t=>t*t*(3-2*t),
    easeOutCubic:t=>1-Math.pow(1-t,3),
    easeOutQuart:t=>1-Math.pow(1-t,4),
    easeOutExpo:t=>t===1?1:1-Math.pow(2,-10*t),
    apple:t=>1-Math.pow(1-t,3.8),
    spring:t=>1-Math.exp(-9*t*.5)*Math.cos(4.2*t*Math.PI),
    easeOutBack:t=>{const u=t-1;return 1+2.70158*u*u*u+1.70158*u*u;},
    bounce:t=>{const n=7.5625,d=2.75;let x=t;
      if(x<1/d)return n*x*x;
      if(x<2/d){x-=1.5/d;return n*x*x+.75;}
      if(x<2.5/d){x-=2.25/d;return n*x*x+.9375;}
      x-=2.625/d;return n*x*x+.984375;},
  };
  function trackValue(track, frame) {
    const keys = track.keyframes;
    if (frame <= keys[0].frame) return keys[0].value;
    for(let i=1;i<keys.length;i++){
      const a=keys[i-1],b=keys[i];
      if(frame<=b.frame){
        const t=(frame-a.frame)/(b.frame-a.frame);
        const easing=easings[a.easing||"linear"];
        return a.value+(b.value-a.value)*easing(t);
      }
    }
    return keys[keys.length-1].value;
  }
  let position = 0, playing = false, raf = 0, lastTick = 0, destroyed = false;
  let resumeOnShow = false;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function render(seconds) {
    position = clamp(seconds,0,maxTime);
    const frame = Math.min(scene.durationFrames-1, position*scene.fps);
    for (const {layer,node} of elements) {
      if (!node) continue;
      const v={x:layer.x,y:layer.y,rotation:layer.rotation,opacity:layer.opacity,
        scaleX:layer.scaleX,scaleY:layer.scaleY,strokeDashoffset:layer.strokeDashoffset};
      for(const track of layer.tracks){
        const value=trackValue(track,frame);
        if(track.property==="scale"){v.scaleX=value;v.scaleY=value;}
        else v[track.property]=value;
      }
      node.setAttribute("transform","translate("+v.x+" "+v.y+") rotate("+v.rotation+") scale("+v.scaleX+" "+v.scaleY+")");
      node.setAttribute("opacity",String(v.opacity));
      const path=node.querySelector("path");
      if(path) path.setAttribute("stroke-dashoffset",String(v.strokeDashoffset));
    }
    progress.value = String(Math.round(position/maxTime*1000));
    timeLabel.textContent = position.toFixed(1)+"s / "+maxTime.toFixed(1)+"s";
  }
  function pause(){
    playing=false;cancelAnimationFrame(raf);raf=0;lastTick=0;
  }
  function tick(now) {
    if(!playing||destroyed)return;
    if(lastTick) position+=Math.min((now-lastTick)/1000,.25);
    lastTick=now;
    if(position>=maxTime){render(maxTime);pause();return;}
    render(position);
    raf=requestAnimationFrame(tick);
  }
  function play(){
    if(destroyed)return;
    if(position>=maxTime) position=0;
    if(playing)return;
    playing=true;lastTick=0;raf=requestAnimationFrame(tick);
  }
  function replay(){pause();render(0);play();}
  function seek(value){pause();render(value);}
  function toggle(){if(playing)pause();else play();}
  document.getElementById("studio-toggle").addEventListener("click",toggle);
  document.getElementById("studio-replay").addEventListener("click",replay);
  progress.addEventListener("input",()=>seek(Number(progress.value)/1000*maxTime));
  const onClick=()=>replay(), onHover=()=>replay(), onLeave=()=>pause();
  const onKey=(event)=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();replay();}};
  const onFocus=()=>replay();
  let scrollStart=window.scrollY;
  const onScroll=()=>seek(clamp((window.scrollY-scrollStart)/Math.max(window.innerHeight,.1),0,1)*maxTime);
  const graphCleanups = [];
  function addGraphListener(element,event,handler){
    element.addEventListener(event,handler);
    graphCleanups.push(()=>element.removeEventListener(event,handler));
  }
  if(scene.graph){
    const readyActions = [];
    for(const binding of scene.graph.bindings){
      const target = binding.target==="stage" ? svg
        : elements.find(item=>item.layer.id===binding.layerId)?.node;
      if(!target)continue;
      const execute = ()=>{
        if(destroyed)return;
        if(binding.action==="play")play();
        else if(binding.action==="pause")pause();
        else if(binding.action==="replay")replay();
        else if(binding.action==="seek")seek(binding.progress*maxTime);
      };
      if(binding.event==="ready"){readyActions.push(execute);continue;}
      if(binding.event==="scroll"){
        addGraphListener(window,"scroll",onScroll);
        continue;
      }
      addGraphListener(target,binding.event,execute);
      // Focus is keyboard-native on the stage and exported interactive layer.
      if(binding.target==="layer" && (binding.event==="click" || binding.event==="focus")){
        if(!target.hasAttribute("tabindex"))target.setAttribute("tabindex","0");
        if(binding.event==="click"){
          const keyboard=(ev)=>{
            if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();execute();}
          };
          addGraphListener(target,"keydown",keyboard);
        }
      }
    }
    if(!reduced)queueMicrotask(()=>{if(!destroyed)for(const action of readyActions)action();});
  }
  if(!scene.graph && scene.trigger==="click"){
    svg.addEventListener("click",onClick);svg.addEventListener("keydown",onKey);
  }else if(!scene.graph && scene.trigger==="hover"){
    svg.addEventListener("mouseenter",onHover);
    svg.addEventListener("mouseleave",onLeave);
    svg.addEventListener("focus",onFocus);
  }else if(!scene.graph && scene.trigger==="scroll"){
    window.addEventListener("scroll",onScroll,{passive:true});
  }
  function onVisibility(){
    if(document.hidden){resumeOnShow=playing;pause();}
    else if(resumeOnShow){resumeOnShow=false;play();}
  }
  document.addEventListener("visibilitychange",onVisibility);
  function destroy(){
    if(destroyed)return;
    pause();destroyed=true;
    svg.removeEventListener("click",onClick);
    svg.removeEventListener("keydown",onKey);
    svg.removeEventListener("mouseenter",onHover);
    svg.removeEventListener("mouseleave",onLeave);
    svg.removeEventListener("focus",onFocus);
    window.removeEventListener("scroll",onScroll);
    for(const release of graphCleanups)release();
    document.removeEventListener("visibilitychange",onVisibility);
    window.removeEventListener("pagehide",destroy);
    document.getElementById("studio-toggle").removeEventListener("click",toggle);
    document.getElementById("studio-replay").removeEventListener("click",replay);
  }
  window.addEventListener("pagehide",destroy,{once:true});
  // First-party deterministic frame-seeking bridge for isolated HTML/React
  // to MP4 capture. No parent-window messaging or cross-origin access.
  window.__studioStopCapture = () => pause();
  window.__studioRenderAt = (seconds) => { pause(); render(seconds); };
  render(reduced ? maxTime : 0);
  if(reduced)notice.textContent="Reduced motion enabled: final frame shown; manual controls remain available.";
  else if(!scene.graph && scene.trigger==="autoplay")play();
})();
</script>
</body></html>`;
}
