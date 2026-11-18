/**
 * Bun-backed Windows ConPTY adapter for attended LAN support sessions.
 * Never launches elevated or detached; the caller owns consent and lifecycle.
 */
export type ConptyProcess = {
  pid: number;
  exited: Promise<number>;
  kill(): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
};

type NativeTerminal = {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
};
type NativeChild = {
  pid: number;
  exited: Promise<number>;
  kill(): void;
  terminal?: NativeTerminal | null;
};
type BunPtyRuntime = {
  spawn(command: string[], options: {
    windowsHide: boolean;
    terminal: {
      cols: number;
      rows: number;
      data: (terminal: NativeTerminal, bytes: Uint8Array) => void;
    };
  }): NativeChild;
};

export function spawnWindowsConpty(command: string, onData: (chunk: Buffer) => void): ConptyProcess | null {
  if (process.platform !== "win32") return null;
  const bun = (globalThis as typeof globalThis & { Bun?: BunPtyRuntime }).Bun;
  if (typeof bun?.spawn !== "function") return null;
  const child = bun.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-Command", command], {
    windowsHide: true,
    terminal: { cols: 80, rows: 24, data: (_term, bytes) => onData(Buffer.from(bytes)) },
  });
  const terminal = child.terminal;
  if (!terminal) {
    child.kill();
    throw Error("Bun did not return a ConPTY terminal.");
  }
  return {
    pid: child.pid,
    exited: child.exited,
    kill: () => child.kill(),
    write: data => { terminal.write(data); },
    resize: (cols, rows) => terminal.resize(cols, rows),
    close: () => terminal.close(),
  };
}
