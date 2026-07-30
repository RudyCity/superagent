import { EventEmitter } from "events";

export type SshConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface SshTransferProgress {
  path: string;
  direction: "upload" | "download";
  bytesTransferred: number;
  totalBytes: number;
  percent: number;
}

export interface SshPortForward {
  type: "local" | "remote";
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

class SshEventEmitter extends EventEmitter {
  private currentState: SshConnectionState = "disconnected";

  getState(): SshConnectionState { return this.currentState; }

  setState(state: SshConnectionState, data?: any): void {
    const prev = this.currentState;
    this.currentState = state;
    this.emit("state_change", { from: prev, to: state, data });
    this.emit(state, data);
  }

  emitTransferProgress(p: SshTransferProgress): void { this.emit("transfer_progress", p); }
  emitPortForward(i: SshPortForward): void { this.emit("port_forward", i); }

  onStateChange(l: (d: any) => void): void { this.on("state_change", l); }
  onTransferProgress(l: (p: SshTransferProgress) => void): void { this.on("transfer_progress", l); }
  onPortForward(l: (i: SshPortForward) => void): void { this.on("port_forward", l); }

  destroy(): void { this.removeAllListeners(); this.currentState = "disconnected"; }
}

export const sshEvents = new SshEventEmitter();
