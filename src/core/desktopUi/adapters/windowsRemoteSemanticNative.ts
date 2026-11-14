/**
 * Verified fixed-path Windows x64 UIA native DLL loader.
 * No child process, network, IPC, or coordinate dispatch.
 */
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteHostScope } from "../remoteControlAuthority.js";
import type {
  WindowsNativeSemanticBinding, WindowsNativeSemanticObservation,
} from "./windowsRemoteSemantic.js";

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)),
  "../../../../native/desktop-live-windows-input");
const binary = path.join(folder, "winremote.dll");
const receipt = path.join(folder, "winremote.sha256");

function verifiedBinary(): string | null {
  try {
    if (process.platform !== "win32" || process.arch !== "x64") return null;
    const dir = lstatSync(folder);
    const file = lstatSync(binary);
    const sum = lstatSync(receipt);
    if (!dir.isDirectory() || dir.isSymbolicLink() ||
        !file.isFile() || file.isSymbolicLink() ||
        !sum.isFile() || sum.isSymbolicLink() ||
        realpathSync(binary) !== binary || realpathSync(receipt) !== receipt ||
        file.size < 8_192 || file.size > 4 * 1024 * 1024 || sum.size > 128) return null;
    const bytes = readFileSync(binary);
    if (bytes.toString("ascii", 0, 2) !== "MZ" || bytes.length < 512) return null;
    const pe = bytes.readUInt32LE(0x3c);
    if (pe < 0x40 || pe + 24 > bytes.length ||
        bytes.toString("ascii", pe, pe + 4) !== "PE\u0000\u0000" ||
        bytes.readUInt16LE(pe + 4) !== 0x8664) return null;
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (readFileSync(receipt, "utf8").trim() !== digest) return null;
    return binary;
  } catch { return null; }
}

function wide(s: string): Buffer { return Buffer.from(s + "\u0000", "utf16le"); }
function scopeArgs(s: Readonly<RemoteHostScope>, nativeRef: string): readonly [Buffer, number, Buffer, Buffer, Buffer, Buffer] {
  return [wide(s.nativeId), s.pid, wide(s.processBirthId), wide(s.osUserId),
    wide(s.hostSessionId), wide(nativeRef)];
}

export interface WindowsRemoteNativeLibrary extends WindowsNativeSemanticBinding {
  /** Negative native return codes remain fail closed. Diagnostics never include user data. */
  lastStatus(): number;
  close(): void;
}

/** Returns null if uncompiled, tampered, unsupported, or not Bun x64. */
export async function openVerifiedWindowsRemoteSemanticNative(): Promise<WindowsRemoteNativeLibrary | null> {
  const fixed = verifiedBinary();
  if (!fixed || !(process.versions as Record<string, string | undefined>).bun) return null;
  try {
    const moduleName = "bun:ffi";
    const ffi = await import(moduleName);
    const { dlopen, FFIType } = ffi;
    const lib = dlopen(fixed, {
      WindowsRemoteInspect: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr,
          FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      WindowsRemoteAct: {
        args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr,
          FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u32,
          FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    let closed = false;
    let lastStatus = 0;
    return {
      lastStatus(): number { return lastStatus; },
      inspect(scope, nativeRef): WindowsNativeSemanticObservation | null {
        if (closed) return null;
        const fields = scopeArgs(scope, nativeRef);
        const output = Buffer.alloc(16_385);
        const n = lib.symbols.WindowsRemoteInspect(...fields, output, output.byteLength);
        lastStatus = n;
        if (!Number.isInteger(n) || n <= 0 || n > 16_384 || output[n] !== 0) return null;
        const proof = output.subarray(0, n).toString("utf8");
        try {
          const value = JSON.parse(proof);
          if (!value || typeof value !== "object") return null;
          return { element: value, proof };
        } catch { return null; }
      },
      act(scope, nativeRef, kind, proof, text, deltaX, deltaY, authorizeNow): boolean {
        if (closed || !["click", "type", "scroll"].includes(kind) ||
            !Number.isSafeInteger(deltaX) || !Number.isSafeInteger(deltaY) ||
            typeof authorizeNow !== "function") return false;
        const fields = scopeArgs(scope, nativeRef);
        const encodedProof = Buffer.from(proof, "utf8");
        if (encodedProof.length < 16 || encodedProof.length > 16_384) return false;
        let callbackCalls = 0;
        let approved = false;
        const callback = new ffi.JSCallback((): number => {
          if (callbackCalls++ !== 0) return 0;
          try { authorizeNow(); approved = true; return 1; }
          catch { return 0; } // Never throw across an unmanaged C ABI frame.
        }, { args: [], returns: FFIType.i32 });
        try {
          const result = lib.symbols.WindowsRemoteAct(...fields, encodedProof,
            encodedProof.length, kind === "click" ? 1 : kind === "type" ? 2 : 3,
            wide(text), deltaX, deltaY, callback.ptr);
          lastStatus = result;
          return approved && callbackCalls === 1 && result === 1;
        } finally { callback.close(); }
      },
      close(): void { if (!closed) { closed = true; lib.close(); } },
    };
  } catch { return null; }
}
