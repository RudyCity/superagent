import net from "node:net";
import { getBrowserProcessManager } from "../dist/core/browserRuntime/browserProcessManager.js";
const alloc = () => new Promise((resolve,reject)=>{const s=net.createServer(); s.on("error",reject); s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const [port,vncPort,noVncPort]=await Promise.all([alloc(),alloc(),alloc()]);
const manager=getBrowserProcessManager();
let instance;
try {
  console.log("M4C_OWNED_LAUNCH_START",JSON.stringify({port,vncPort,noVncPort,platform:process.platform}));
  instance=await manager.launchBrowser({
    port,mode:"virtual-display",executablePath:"/usr/bin/google-chrome",
    timeoutMs:20000,url:"about:blank",virtualDisplay:{enableLocalVnc:true,enableLocalNoVnc:true,vncPort,noVncPort}
  });
  const health=await manager.checkHealth(port);
  const display=instance.virtualDisplay;
  console.log("M4C_OWNED_LAUNCH_RESULT",JSON.stringify({
    browser:instance.browserFingerprint?.slice(0,10), pid:instance.pid,
    display:display?.displayStr,vnc:display?.vncPort,novnc:display?.noVncPort,
    health:health.status,virtualDisplay:health.virtualDisplay
  }));
  if(!display?.vncPort||!display?.noVncPort || health.status==="stopped")throw Error("Runtime not ready");
} finally {
  if(instance) console.log("M4C_OWNED_STOP",JSON.stringify(await manager.stopBrowser({port})));
}
