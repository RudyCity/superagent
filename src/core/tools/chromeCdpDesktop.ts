/**
 * Opt-in discovery of local Electron / TLine CDP debugging endpoints.
 * Probes only user-specified loopback ports, does not launch or modify apps.
 * Supports modern CDP endpoints which require a WebSocket upgrade on /json/list.
 */
import { get as httpGet } from "node:http";
import { WebSocket } from "ws";
export interface DesktopCdpProbe {
  port: number;
  available: boolean;
  applicationHint: string;
  targets: Array<{ id: string; type: string; title: string; url: string; connectable: boolean }>;
  error?: string;
}
function parseTargets(base: DesktopCdpProbe, input: string): DesktopCdpProbe {
  const data: unknown = JSON.parse(input);
  if (!Array.isArray(data)) throw new Error("Unexpected CDP target response");
  const targets = data.slice(0, 60).filter((item: any) => item && typeof item.id === "string")
    .map((item: any) => ({
      id: String(item.id).slice(0, 150),
      type: String(item.type || "").slice(0, 40),
      title: String(item.title || "").slice(0, 180),
      url: String(item.url || "").slice(0, 350),
      connectable: typeof item.webSocketDebuggerUrl === "string",
    }));
  const matchesTline = targets.some((item: DesktopCdpProbe["targets"][number]) =>
    /\bt-?line\b/i.test(item.title + " " + item.url));
  return { ...base, available: true, targets,
    applicationHint: matchesTline ? "possible-tline-electron" : "chromium-or-electron" };
}
function probeWebSocket(base: DesktopCdpProbe): Promise<DesktopCdpProbe> {
  return new Promise((resolve) => {
    const port = base.port;
    const ws = new WebSocket("ws://127.0.0.1:" + port + "/json/list", {
      handshakeTimeout: 1500, origin: "http://127.0.0.1:" + port,
    });
    let doneAlready = false;
    const finish = (data: DesktopCdpProbe): void => {
      if (doneAlready) return;
      doneAlready = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      resolve(data);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      finish({ ...base, error: "CDP WebSocket discovery timed out after HTTP 426" });
    }, 2000);
    ws.on("message", (value) => {
      const raw = String(value);
      if (raw.length > 1048576) {
        finish({ ...base, error: "CDP WS target response too large" });
        return;
      }
      try { finish(parseTargets(base, raw)); }
      catch (error: any) { finish({ ...base, error: "CDP WS response invalid: " + String(error?.message || error) }); }
    });
    ws.on("error", (error: Error) =>
      finish({ ...base, error: "CDP HTTP 426; WebSocket fallback failed: " + error.message }));
    ws.on("close", () => {
      if (!doneAlready) finish({ ...base, error: "CDP HTTP 426; WebSocket fallback closed without targets" });
    });
  });
}
function probe(port: number): Promise<DesktopCdpProbe> {
  return new Promise((resolve) => {
    const base: DesktopCdpProbe = { port, available: false, applicationHint: "chromium-or-electron", targets: [] };
    let complete = false;
    const done = (data: DesktopCdpProbe) => { if (!complete) { complete = true; resolve(data); } };
    const req = httpGet({ hostname: "127.0.0.1", port, path: "/json/list", timeout: 1500 }, (response) => {
      if (response.statusCode === 426) {
        response.resume();
        void probeWebSocket(base).then(done);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        done({ ...base, error: "CDP discovery HTTP " + response.statusCode });
        return;
      }
      let body = "";
      response.on("data", (chunk: Buffer) => {
        body += String(chunk);
        if (body.length > 1048576) req.destroy(new Error("Discovery response too large"));
      });
      response.on("end", () => {
        try { done(parseTargets(base, body)); }
        catch (err: any) { done({ ...base, error: String(err?.message || err) }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("CDP discovery timed out")));
    req.on("error", (err: Error) => done({ ...base, error: err.message }));
  });
}
export async function discoverDesktopTargets(portList: string): Promise<{
  probes: DesktopCdpProbe[];
  note: string;
}> {
  const raw = portList.split(",").map((s) => s.trim()).filter(Boolean);
  if (!raw.length || raw.length > 8 ||
      raw.some((s) => !/^\d{4,5}$/.test(s) || +s < 1024 || +s > 65535)) {
    throw new Error("Supply 1-8 explicitly selected local CDP ports (1024-65535) using debug_ports.");
  }
  const ports = [...new Set(raw.map(Number))];
  return {
    probes: await Promise.all(ports.map(probe)),
    note: "Electron/TLine access requires the desktop app to expose its Chromium debugging port. Select the matching debug_port and targetId for subsequent commands; discovery does not grant access to OS-native terminals.",
  };
}
