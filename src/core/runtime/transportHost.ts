/**
 * Standalone, opt-in T-Line HTTP/SSE/WebSocket transport front door.
 * Runs in a SEPARATE process from the core supervisor. Does not own any MCP,
 * Muse, Telegram or AI workers. It retains its listening socket if the core
 * supervisor is restarted/recovered, and does not take over the core port.
 *
 * Existing SSE and WebSocket connections depend on the upstream process; a
 * supervisor crash can still break them. Clients reconnect to this stable
 * listener and resubmit their sessionId.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getRootConfigDir } from "../config/paths.js";
import net from "node:net";
import { readCoreCheckpoint } from "./coreSupervisorCheckpoint.js";
import { requestCoreSupervisor } from "./coreSupervisor.js";

export interface TransportHostStatus {
  service: "superagent-transport-host";
  pid: number;
  publicPort: number;
  corePort: number;
  backendReady: boolean;
  activeHttpRequests: number;
  upgradedSockets: number;
  instanceId?: string;
  draining?: boolean;
}

export interface TransportOwnerRecord {
  version: 1; port: number; pid: number; corePort: number;
  instanceId: string; token: string;
}
export function transportOwnerPath(port: number) {
  return path.join(getRootConfigDir(), "transport-host-" + port + ".json");
}
export function readTransportOwner(port: number): TransportOwnerRecord | null {
  const file=transportOwnerPath(port);
  let stat:fs.Stats;
  try {stat=fs.lstatSync(file);}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT")return null;
    throw e;
  }
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>2048)
    throw new Error("TRANSPORT_OWNER_UNSAFE_RECORD");
  const x=JSON.parse(fs.readFileSync(file,"utf8")) as TransportOwnerRecord;
  if(x.version!==1||x.port!==port||!validTransportPort(port)||
     !Number.isSafeInteger(x.pid)||x.pid<=0||!validTransportPort(x.corePort)||
     !/^[a-f0-9]{32}$/.test(x.instanceId)||!/^[a-f0-9]{64}$/.test(x.token))
    throw new Error("TRANSPORT_OWNER_INVALID_RECORD");
  return x;
}
export async function requestTransportStop(port:number,expectedPid:number) {
  const state=readTransportOwner(port);
  if(!state||state.pid!==expectedPid)throw new Error("TRANSPORT_OWNER_CHANGED");
  const {readListenerOwners}=await import("./coreMcpOwnershipAudit.js");
  if(readListenerOwners()?.get(port)!==state.pid)
    throw new Error("TRANSPORT_KERNEL_OWNER_MISMATCH");
  const response=await fetch("http://127.0.0.1:"+port+"/_transport/control",{
    method:"POST",headers:{"Authorization":"Bearer "+state.token,
      "Content-Type":"application/json"},
    body:JSON.stringify({action:"stop",instanceId:state.instanceId}),
    signal:AbortSignal.timeout(4000),
  });
  const result=await response.json().catch(()=>null) as {ok?:boolean;code?:string}|null;
  if(!response.ok||result?.ok!==true)
    throw new Error(result?.code||"TRANSPORT_STOP_REFUSED");
  return {port,previousPid:state.pid,stopping:true};
}

export function validTransportPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function privatePath(rawUrl: string | undefined): boolean {
  try {
    const pathname = new URL(rawUrl || "/", "http://127.0.0.1").pathname;
    return pathname === "/_core" || pathname.startsWith("/_core/") ||
      pathname === "/_transport" || pathname.startsWith("/_transport/");
  } catch {
    return true;
  }
}

async function probeBackend(corePort: number): Promise<boolean> {
  let bearer = "";
  try { bearer = readCoreCheckpoint(corePort).serverToken; }
  catch { return false; }
  return new Promise(resolve => {
    const req = http.get({
      hostname: "127.0.0.1", port: corePort, path: "/api/status",
      timeout: 900, headers: { Authorization: "Bearer " + bearer },
    }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.once("error", () => resolve(false));
    req.once("timeout", () => req.destroy());
  });
}

export async function runTransportHost(
  port: number, corePort: number,
  // Test-only injectable verification; CLI always uses authenticated control.
  verifyOwner: (corePort: number) => Promise<boolean> = async (target) => {
    try {
      const status = await requestCoreSupervisor("status", target, 1800);
      return status.publicPort === target && status.supervisorPid > 0 &&
        status.active.pid > 0;
    } catch { return false; }
  },
): Promise<{ server: http.Server; port: number }> {
  if ((!validTransportPort(port) && port !== 0) || !validTransportPort(corePort) ||
      port === corePort) throw new Error("Invalid transport/core port pair");
  let activeHttpRequests = 0;
  let upgradedSockets = 0;
  let draining = false;
  // A port-0 in-process test owner has no external lifecycle contract.
  const owner = port===0 ? null : {
    version:1 as const,port,pid:process.pid,corePort,
    instanceId:crypto.randomBytes(16).toString("hex"),
    token:crypto.randomBytes(32).toString("hex"),
  };
  const server = http.createServer(async (req, res) => {
    if(req.method==="POST" && new URL(req.url||"/","http://127.0.0.1").pathname==="/_transport/control"){
      const loopback=req.socket.remoteAddress==="127.0.0.1"||req.socket.remoteAddress==="::1";
      const auth=Buffer.from(req.headers.authorization||"");
      const expected=Buffer.from(owner?"Bearer "+owner.token:"");
      if(!owner||!loopback||auth.length!==expected.length||
         !crypto.timingSafeEqual(auth,expected)){
        res.writeHead(401,{"Cache-Control":"no-store"});res.end();req.resume();return;
      }
      req.setTimeout(2500,()=>req.destroy());
      let body="";
      for await(const chunk of req) {
        body+=String(chunk);
        if(body.length>256){res.writeHead(413);res.end();return;}
      }
      let command:any=null;
      try{command=JSON.parse(body);}catch{}
      if(command?.action!=="stop"||command.instanceId!==owner.instanceId){
        res.writeHead(400);res.end();return;
      }
      if(draining||activeHttpRequests!==0||upgradedSockets!==0){
        res.writeHead(409,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false,code:"TRANSPORT_ACTIVE_CONNECTIONS"}));return;
      }
      draining=true;
      res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"no-store"});
      res.end(JSON.stringify({ok:true,stopping:true}));
      setTimeout(()=>server.close(),30).unref();
      return;
    }

    const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/_transport/health" && req.method === "GET") {
      const backendReady = await verifyOwner(corePort) && await probeBackend(corePort);
      const address = server.address();
      const boundPort = address && typeof address !== "string" ? address.port : port;
      const status: TransportHostStatus = {
        service: "superagent-transport-host", pid: process.pid,
        publicPort: boundPort, corePort, backendReady,
        activeHttpRequests, upgradedSockets,
        ...(owner ? {instanceId:owner.instanceId,draining}:{}),
      };
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(status));
      return;
    }
    if (privatePath(req.url)) { res.writeHead(404); res.end(); return; }
    if (draining){res.writeHead(503,{"Retry-After":"1"});res.end();return;}
    if (!await verifyOwner(corePort)) {
      res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store", "Retry-After": "1" });
      res.end(JSON.stringify({
        error: "Authenticated core supervisor unavailable",
        code: "CORE_SUPERVISOR_UNAVAILABLE",
        retryAfterMs: 1000,
        safeReconnectMethod: "GET",
        automaticChatReplayAllowed: false,
      }));
      req.resume();
      return;
    }
    activeHttpRequests++;
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      activeHttpRequests--;
    };
    res.once("finish", release);
    res.once("close", release);
    const headers = { ...req.headers };
    delete headers["x-superagent-internal-token"];
    const upstream = http.request({
      hostname: "127.0.0.1", port: corePort,
      path: req.url, method: req.method, headers,
    }, remote => {
      res.writeHead(remote.statusCode || 502, remote.headers);
      remote.pipe(res);
    });
    upstream.once("error", () => {
      if (res.headersSent) {
        // Do not append a JSON error into an existing SSE/streaming body.
        res.destroy();
        return;
      }
      res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "1", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        error: "Core supervisor unavailable; reconnect after recovery",
        code: "CORE_SUPERVISOR_UNAVAILABLE",
        retryAfterMs: 1000,
        safeReconnectMethod: "GET",
        automaticChatReplayAllowed: false,
      }));
    });
    res.once("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.once("error", () => upstream.destroy());
    req.pipe(upstream);
  });
  server.on("upgrade", (req, socket, head) => {
    if (draining || privatePath(req.url)) { socket.destroy(); return; }
    void verifyOwner(corePort).then(verified => {
      if (!verified) { socket.destroy(); return; }
      upgradedSockets++;
    let closed = false;
    const release = () => {
      if (closed) return;
      closed = true;
      upgradedSockets--;
    };
    const upstream = net.connect(corePort, "127.0.0.1", () => {
      const lines = [req.method + " " + (req.url || "/") + " HTTP/" + req.httpVersion];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === "x-superagent-internal-token") continue;
        lines.push(req.rawHeaders[i] + ": " + req.rawHeaders[i + 1]);
      }
      upstream.write(lines.join("\r\n") + "\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.once("close", release);
    upstream.once("close", release);
    upstream.once("error", () => socket.destroy());
    socket.once("error", () => upstream.destroy());
    }).catch(() => socket.destroy());
  });
  if(owner){
    const file=transportOwnerPath(port);
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    const folder=fs.lstatSync(path.dirname(file));
    if(!folder.isDirectory()||folder.isSymbolicLink())
      throw new Error("TRANSPORT_OWNER_UNSAFE_DIRECTORY");
    // Never adopt a stale/foreign owner. An operator must investigate first.
    fs.writeFileSync(file,JSON.stringify(owner),{encoding:"utf8",flag:"wx",mode:0o600});
    server.once("close",()=>{
      try{
        const current=readTransportOwner(port);
        if(current?.pid===owner.pid&&current.instanceId===owner.instanceId)
          fs.rmSync(file,{force:true});
      }catch{}
    });
  }
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  }catch(e){
    if(owner){
      try{
        const current=readTransportOwner(port);
        if(current?.instanceId===owner.instanceId)fs.rmSync(transportOwnerPath(port),{force:true});
      }catch{}
    }
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Transport listener did not bind");
  // Only service-manager spawned children exit with their listener. The
  // ordinary CLI/test owner contract remains unchanged.
  if (process.env.SUPERAGENT_MANAGED_SIDECAR === "1") {
    server.once("close", () => setImmediate(() => process.exit(0)));
  }
  return { server, port: address.port };
}

export async function handleTransportCliCommand(argv: string[]): Promise<boolean> {
  const action = argv[0]?.toLowerCase() || "help";
  const index = argv.indexOf("--port");
  const port = index < 0 ? 7891 : Number(argv[index + 1]);
  const coreIndex = argv.indexOf("--core-port");
  const corePort = coreIndex < 0 ? 7888 : Number(argv[coreIndex + 1]);
  if (action === "help" || action === "--help") {
    console.log("superagent transport start [--port 7891] [--core-port 7888]");
    console.log("superagent transport status [--port 7891]");
    console.log("Independent loopback T-Line REST/SSE/WS front door; does not start or stop core/MCP/Muse/Telegram.");
    return false;
  }
  if (!validTransportPort(port) || !validTransportPort(corePort) || port === corePort) {
    throw new Error("Transport --port and --core-port must be distinct valid TCP ports");
  }
  if (action === "start") {
    await runTransportHost(port, corePort);
    console.log("Transport host listening on http://127.0.0.1:" + port +
      " (core supervisor: " + corePort + ")");
    return true;
  }
  if (action === "status") {
    const response = await fetch("http://127.0.0.1:" + port + "/_transport/health", {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Transport host returned status " + response.status);
    const json = await response.json() as TransportHostStatus;
    if (json.service !== "superagent-transport-host" || json.publicPort !== port) {
      throw new Error("Port does not belong to an identified SuperAgent transport host");
    }
    console.log("T-Line transport host: ACTIVE");
    console.log("Listening port: " + json.publicPort + "; PID " + json.pid);
    console.log("Core supervisor port: " + json.corePort +
      "; backend: " + (json.backendReady ? "READY" : "UNAVAILABLE"));
    console.log("HTTP streams: " + json.activeHttpRequests +
      "; upgraded sockets: " + json.upgradedSockets);
    return false;
  }
  throw new Error("Expected transport start, status or help");
}
