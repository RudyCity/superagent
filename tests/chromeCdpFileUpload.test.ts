import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  captureFileChooserEvent,
  clearFileChooserEvent,
  executeFileUploadCommand,
  validateUploadPaths,
  type FileCdpSend,
} from "../src/core/tools/chromeCdpFileUpload.js";

let root = "";
let names: string[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "superagent-file-cdp-test-"));
  names = [];
  await fs.writeFile(path.join(root, "small.pdf"), "pdf fixture");
  await fs.writeFile(path.join(root, "second.pdf"), "another fixture");
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  clearFileChooserEvent("mock-target");
  vi.restoreAllMocks();
});

function makeCdp(options: { multiple?: boolean; disabled?: boolean; count?: number } = {}) {
  const methods: { method: string; params: Record<string, unknown> }[] = [];
  const send: FileCdpSend = async (method, params = {}) => {
    methods.push({ method, params });
    switch (method) {
      case "DOM.getDocument": return { root: { nodeId: 1 } };
      case "DOM.querySelectorAll": return { nodeIds: Array.from({ length: options.count ?? 1 }, (_, i) => 101 + i) };
      case "DOM.describeNode": return { node: { nodeName: "INPUT", attributes: [
        "type", "file",
        ...(options.multiple ? ["multiple", ""] : []),
        ...(options.disabled ? ["disabled", ""] : []),
      ] } };
      case "DOM.setFileInputFiles":
        names = ((params.files || []) as string[]).map(f => path.basename(f));
        return {};
      case "Runtime.evaluate":
        return { result: { value: [
          { index: 0, tag: "input", type: "file", disabled: !!options.disabled, multiple: !!options.multiple,
            accept: ".pdf", hidden: true, selected: names.map(name => ({ name, size: 12 })) },
        ] } };
      default: return {};
    }
  };
  return { send, methods };
}

describe("SuperAgent Chrome CDP local file upload", () => {
  it("denies files outside workspace unless explicitly authorized", async () => {
    await expect(validateUploadPaths({ filePath: path.join(root, "small.pdf") }, path.join(root, "subdirectory")))
      .rejects.toThrow(/outside authorized workspace/);
    await expect(validateUploadPaths({
      filePath: path.join(root, "small.pdf"), allowOutsideWorkspace: true, confirmExternalFile: true,
    }, path.join(root, "subdirectory"))).resolves.toHaveLength(1);
  });

  it("rejects invalid/missing paths, duplicates, and relative paths", async () => {
    await expect(validateUploadPaths({ filePath: "small.pdf" }, root)).rejects.toThrow(/absolute/);
    await expect(validateUploadPaths({ filePath: path.join(root, "missing.txt") }, root)).rejects.toThrow(/does not exist/);
    await expect(validateUploadPaths({ files: [path.join(root, "small.pdf"), path.join(root, "small.pdf")] }, root))
      .rejects.toThrow(/Duplicate/);
  });

  it("uploads one file directly with DOM.setFileInputFiles and verifies selection only", async () => {
    const { send, methods } = makeCdp();
    const text = await executeFileUploadCommand("upload_file", send, "mock-target",
      { filePath: path.join(root, "small.pdf") }, root);
    const result = JSON.parse(text);
    expect(result.status).toBe("selected_in_browser");
    expect(result.files).toEqual(["small.pdf"]);
    expect(result.serverUploadConfirmed).toBe(false);
    expect(methods.some(row => row.method === "DOM.setFileInputFiles" && row.params.nodeId === 101)).toBe(true);
    expect(methods.some(row => row.method === "Page.navigate" || row.method === "Input.dispatchMouseEvent")).toBe(false);
  });

  it("supports multi-file input and rejects multiple files for single input", async () => {
    const files = [path.join(root, "small.pdf"), path.join(root, "second.pdf")];
    const multi = makeCdp({ multiple: true });
    const result = JSON.parse(await executeFileUploadCommand("upload_file", multi.send, "mock-target", { files }, root));
    expect(result.files).toEqual(["small.pdf", "second.pdf"]);
    const single = makeCdp();
    await expect(executeFileUploadCommand("upload_file", single.send, "mock-target", { files }, root))
      .rejects.toThrow(/does not support multiple/);
  });

  it("rejects disabled or ambiguous inputs", async () => {
    await expect(executeFileUploadCommand("upload_file", makeCdp({ disabled: true }).send, "mock-target",
      { filePath: path.join(root, "small.pdf") }, root)).rejects.toThrow(/disabled/);
    await expect(executeFileUploadCommand("upload_file", makeCdp({ count: 2 }).send, "mock-target",
      { filePath: path.join(root, "small.pdf") }, root)).rejects.toThrow(/More than one/);
  });

  it("reports file inputs without modifying the page", async () => {
    const { send, methods } = makeCdp();
    const result = JSON.parse(await executeFileUploadCommand("list_file_inputs", send, "mock-target", {}, root));
    expect(result.count).toBe(1);
    expect(result.inputs[0].type).toBe("file");
    expect(methods.map(m => m.method)).toEqual(["Runtime.evaluate"]);
  });

  it("arms a Chrome file chooser without auto-submitting a form", async () => {
    const { send, methods } = makeCdp();
    const result = JSON.parse(await executeFileUploadCommand("handle_file_chooser", send, "mock-target", { arm: true }, root));
    expect(result.status).toBe("armed");
    expect(methods.map(m => m.method)).toEqual(["Page.enable", "Page.setInterceptFileChooserDialog"]);
  });

  it("uses backendNodeId when a chooser event has been intercepted", async () => {
    captureFileChooserEvent("mock-target", "Page.fileChooserOpened", { backendNodeId: 777, mode: "selectSingle" });
    const { send, methods } = makeCdp();
    const result = JSON.parse(await executeFileUploadCommand("handle_file_chooser", send, "mock-target",
      { filePath: path.join(root, "small.pdf") }, root));
    expect(result.status).toBe("selected_in_browser");
    expect(methods.find(m => m.method === "DOM.setFileInputFiles")?.params.backendNodeId).toBe(777);
  });

  it("uses the sanitized Delegate file chooser event shape", async () => {
    const { send, methods } = makeCdp();
    const result = JSON.parse(await executeFileUploadCommand("handle_file_chooser", send, "mock-target",
      { filePath: path.join(root, "small.pdf") }, root,
      async () => [{ method: "Page.fileChooserOpened", backendNodeId: 919, mode: "selectSingle" }]));
    expect(result.status).toBe("selected_in_browser");
    expect(methods.find(m => m.method === "DOM.setFileInputFiles")?.params.backendNodeId).toBe(919);
  });

  it("prevents intercepted single-select choosers from receiving multiple files", async () => {
    const { send } = makeCdp({ multiple: true });
    await expect(executeFileUploadCommand("handle_file_chooser", send, "mock-target",
      { files: [path.join(root, "small.pdf"), path.join(root, "second.pdf")] }, root,
      async () => [{ method: "Page.fileChooserOpened", backendNodeId: 919, mode: "selectSingle" }]))
      .rejects.toThrow(/accepts only one/);
  });

  it("requires explicit opt-in before touching a native Windows Open File dialog", async () => {
    const { send, methods } = makeCdp();
    await expect(executeFileUploadCommand("handle_file_chooser", send, "mock-target",
      { nativeDialog: true, filePath: path.join(root, "small.pdf") }, root))
      .rejects.toThrow(/requires confirmNativeDialog|supported only on Windows/);
    expect(methods).toHaveLength(0);
  });

  it("does not claim server success without explicit proof", async () => {
    const { send } = makeCdp();
    const result = JSON.parse(await executeFileUploadCommand("verify_upload", send, "mock-target", {}, root));
    expect(result.status).toBe("unverified");
    expect(result.serverUploadConfirmed).toBe(false);
  });
});
