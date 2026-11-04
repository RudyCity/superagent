/**
 * Private, authenticated local lifecycle for an independently owned Muse
 * watcher. No exec/kill/replay IPC, no public socket and no credential is
 * returned by the health/status response.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface MusePrivateState {
  version: 1;
  pid: number;
  processStartedAt: number;
  controlId: string;
  controlPort: number;
  controlToken: string;
}

export type MuseOwnerAction = "stop" | "restart";

export interface MuseOwnerCallbacks {
  status(): {
    running: boolean;
    ready: boolean;
    activeTask: boolean;
    queueSize: number;
    tunnelOwned: boolean;
    tokenRotationSupported?: boolean;
  };
  change(action: MuseOwnerAction): Promise<void>;
  /** Implemented only for a running inbound Muse WebSocket owner. */
  rotateToken?: () => Promise<{copied: boolean}>;
}

export class MuseOwnerLifecycle {
  private readonly state: Omit<MusePrivateState, "controlPort">;
  private readonly ownerFile: string;
  private server: http.Server | null = null;
  private boundPort = 0;
  private busy = false;

  constructor(private readonly ownerDirectory: string,
    private readonly identitySuffix: string,
    private readonly callbacks: MuseOwnerCallbacks) {
    if (!/^[a-f0-9]{12}$/.test(identitySuffix)) {
      throw new Error("Invalid Muse owner identity");
    }
    this.state = {
      version: 1,
      pid: process.pid,
      processStartedAt: Date.now() - Math.round(process.uptime() * 1000),
      controlId: crypto.randomBytes(16).toString("hex"),
      controlToken: crypto.randomBytes(32).toString("hex"),
    };
    this.ownerFile = path.join(ownerDirectory,
      `muse-owner-${process.pid}-${identitySuffix}.json`);
  }

  get port(): number { return this.boundPort; }
  get id(): string { return this.state.controlId; }

  /** When a user stops the watcher through Tray, keep the owner process
   * reachable for an explicit restart even if it has no other event loops.
   * While running, this auxiliary socket never prevents normal CLI exit. */
  holdForRestart(hold: boolean): void {
    if (hold) this.server?.ref();
    else this.server?.unref();
  }

  private status() {
    return {
      version: 1 as const,
      service: "superagent-muse-owner" as const,
      pid: this.state.pid,
      processStartedAt: this.state.processStartedAt,
      controlId: this.state.controlId,
      controlPort: this.boundPort,
      ...this.callbacks.status(),
      tokenRotationSupported: typeof this.callbacks.rotateToken === "function"
        && this.callbacks.status().running === true
        && this.callbacks.status().tokenRotationSupported === true,
    };
  }

  async listen(): Promise<void> {
    if (this.server) return;
    const server = http.createServer(async (req, res) => {
      const reply = (code: number, value: unknown) => {
        res.writeHead(code, {
          "Content-Type":"application/json", "Cache-Control":"no-store",
          "X-Content-Type-Options":"nosniff",
        });
        res.end(JSON.stringify(value));
      };
      if (req.socket.remoteAddress !== "127.0.0.1" &&
          req.socket.remoteAddress !== "::1") {
        reply(404, {error:"Not found"}); return;
      }
      const wanted = Buffer.from("Bearer " + this.state.controlToken);
      const received = Buffer.from(String(req.headers.authorization || ""));
      if (wanted.length !== received.length ||
          !crypto.timingSafeEqual(wanted, received)) {
        reply(401, {error:"Unauthorized"}); req.resume(); return;
      }
      if (req.method === "GET" && req.url === "/_muse/status") {
        reply(200, this.status()); return;
      }
      if (req.method !== "POST" ||
          !["/_muse/stop", "/_muse/restart", "/_muse/token/rotate"].includes(req.url || "")) {
        reply(404, {error:"Unknown Muse lifecycle route"}); return;
      }
      if (this.busy) {reply(409, {error:"Muse lifecycle operation in progress"}); return;}
      const rotate = req.url === "/_muse/token/rotate";
      const action = req.url === "/_muse/stop" ? "stop" : "restart";
      const before = this.callbacks.status();
      if (before.activeTask || before.queueSize > 0) {
        reply(409, {error:"Muse has active or queued tasks. No lifecycle change performed"});
        return;
      }
      if (rotate && (!before.running || before.tokenRotationSupported !== true || !this.callbacks.rotateToken)) {
        reply(409, {error:"Muse token rotation requires a running WebSocket owner"}); return;
      }
      if (!rotate && action === "restart" && before.tunnelOwned) {
        reply(409, {error:"Muse owns a public tunnel; restart could rotate its URL"});
        return;
      }
      if (!rotate && action === "stop" && !before.running) {
        reply(409, {error:"Muse Watch already stopped"}); return;
      }
      this.busy = true;
      try {
        if (rotate) {
          // New token never traverses the owner HTTP response. The watcher
          // copies it to the local OS clipboard and pushes refresh to Muse.
          const result = await this.callbacks.rotateToken!();
          reply(200, {
            success:true, action:"regenerate-token", kind:"muse-watch",
            copied:result.copied === true, pid:this.state.pid,controlId:this.state.controlId,
            message:result.copied
              ? "Muse WebSocket bearer token rotated; setup copied to OS clipboard. Previous token remains valid for 5 minutes."
              : "Muse token rotated but clipboard copy failed. Retrieve the new token from the protected owner configuration.",
          });
        } else {
          await this.callbacks.change(action);
          reply(200, {
            success:true, action, state:this.callbacks.status().running ? "running" : "stopped",
            pid:this.state.pid, controlId:this.state.controlId,
          });
        }
      } catch (error) {
        reply(409, {error:error instanceof Error ? error.message.slice(0,200)
          : "Muse owner rejected lifecycle action"});
      } finally { this.busy = false; }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      const addr = server.address();
      if (!addr || typeof addr === "string" || addr.port <= 0) {
        throw new Error("Muse owner did not bind its private control socket");
      }
      this.boundPort = addr.port;
      fs.mkdirSync(this.ownerDirectory, {recursive:true, mode:0o700});
      // Exclusive owner registration; fail closed on orphan / duplicate owner.
      fs.writeFileSync(this.ownerFile,
        JSON.stringify({...this.state, controlPort:this.boundPort}),
        {mode:0o600,flag:"wx"});
      this.server = server;
      server.unref();
    } catch (error) {
      try { server.close(); } catch {}
      this.boundPort = 0;
      throw error;
    }
  }

  close(): void {
    if (this.server) {
      try { this.server.close(); } catch {}
      this.server = null;
    }
    this.boundPort = 0;
    try { fs.rmSync(this.ownerFile, {force:true}); } catch {}
  }
}
