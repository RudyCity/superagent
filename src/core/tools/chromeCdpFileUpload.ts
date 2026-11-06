import * as fs from "node:fs/promises";
import * as path from "node:path";
import { handleNativeWindowsFileDialog } from "./chromeCdpNativeFileDialog.js";

export type FileUploadCommand = "list_file_inputs" | "upload_file" | "handle_file_chooser" | "verify_upload";
export type FileCdpSend = (method: string, params?: Record<string, unknown>) => Promise<any>;

const MAX_FILES = 10;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const chooserEvents = new Map<string, { backendNodeId: number; mode: string; time: number }>();

export function captureFileChooserEvent(targetId: string, method: string, params: any): void {
  if (method !== "Page.fileChooserOpened") return;
  const backendNodeId = Number(params?.backendNodeId);
  if (Number.isSafeInteger(backendNodeId) && backendNodeId > 0) {
    chooserEvents.set(targetId, { backendNodeId, mode: String(params?.mode || ""), time: Date.now() });
  }
}

export function clearFileChooserEvent(targetId: string): void {
  chooserEvents.delete(targetId);
}

function isWithin(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

export async function validateUploadPaths(payload: Record<string, unknown>, workspace: string): Promise<string[]> {
  const raw = payload.files ?? payload.filePaths ?? payload.paths ?? payload.filePath ?? payload.path;
  const inputs = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_FILES || !inputs.every(p => typeof p === "string" && p.length > 0 && p.length <= 4096)) {
    throw new Error("upload_file requires 1-10 absolute local file paths in files or filePath.");
  }
  const root = await fs.realpath(workspace).catch(() => path.resolve(workspace));
  const allowOutside = payload.allowOutsideWorkspace === true && payload.confirmExternalFile === true;
  let total = 0;
  const result: string[] = [];
  for (const value of inputs as string[]) {
    if (!path.isAbsolute(value)) throw new Error("File path must be absolute. Relative paths and URLs are not accepted.");
    const resolved = await fs.realpath(value).catch(() => { throw new Error("Requested upload file does not exist or is inaccessible."); });
    if (!allowOutside && !isWithin(resolved, root)) {
      throw new Error("File is outside authorized workspace. To upload an explicitly requested external file, set allowOutsideWorkspace and confirmExternalFile to true.");
    }
    const info = await fs.stat(resolved);
    if (!info.isFile()) throw new Error("Upload input must refer to an ordinary file.");
    if (info.size > MAX_FILE_BYTES) throw new Error("Upload file exceeds the 100 MiB per-file limit.");
    total += info.size;
    if (total > MAX_TOTAL_BYTES) throw new Error("Upload files exceed the 200 MiB combined limit.");
    result.push(resolved);
  }
  if (new Set(result.map(p => process.platform === "win32" ? p.toLowerCase() : p)).size !== result.length) {
    throw new Error("Duplicate file paths are not permitted.");
  }
  return result;
}

function resultValue(response: any): any {
  if (response?.exceptionDetails) throw new Error("Unable to inspect file input in the selected browser tab.");
  return response?.result?.value;
}

function fileListScript(selector?: string): string {
  return "(() => { const selector=" + JSON.stringify(selector || "input[type=file]") +
    "; const els=Array.from(document.querySelectorAll(selector)); return els.map((e,i)=>({index:i,tag:e.tagName.toLowerCase(),type:e.type,multiple:e.multiple,disabled:e.disabled,accept:e.accept,hidden:e.getClientRects().length===0,selected:Array.from(e.files||[]).map(f=>({name:f.name,size:f.size}))})); })()";
}

async function listInputs(send: FileCdpSend, selector?: string): Promise<any[]> {
  const value = resultValue(await send("Runtime.evaluate", {
    expression: fileListScript(selector), returnByValue: true,
  }));
  if (!Array.isArray(value)) throw new Error("Could not inspect file inputs.");
  return value;
}

async function getInput(send: FileCdpSend, payload: Record<string, unknown>): Promise<{ nodeId: number; multiple: boolean; disabled: boolean; selector: string; index: number }> {
  const selector = String(payload.selector || "input[type=file]");
  if (!selector || selector.length > 512) throw new Error("Invalid file input CSS selector.");
  const document: any = await send("DOM.getDocument", { depth: 1, pierce: true });
  const rootNodeId = Number(document?.root?.nodeId);
  if (!rootNodeId) throw new Error("Browser DOM is unavailable.");
  const queried: any = await send("DOM.querySelectorAll", { nodeId: rootNodeId, selector });
  const ids: number[] = queried?.nodeIds || [];
  const idxRaw = payload.inputIndex ?? payload.input_index;
  const idx = idxRaw === undefined ? 0 : Number(idxRaw);
  if (!Number.isSafeInteger(idx) || idx < 0) throw new Error("inputIndex must be a zero-based nonnegative integer.");
  if (!ids.length) throw new Error("No matching file input was found. For frames, select the correct tab or frame before upload.");
  if (idxRaw === undefined && ids.length > 1) throw new Error("More than one file input matches. Specify selector or inputIndex.");
  if (idx >= ids.length) throw new Error("inputIndex is out of range.");
  const node: any = await send("DOM.describeNode", { nodeId: ids[idx] });
  const attributes: string[] = node?.node?.attributes || [];
  const attr = new Map<string, string>();
  for (let i = 0; i < attributes.length; i += 2) attr.set(attributes[i].toLowerCase(), attributes[i + 1]);
  if (String(node?.node?.nodeName || "").toLowerCase() !== "input" || (attr.get("type") || "").toLowerCase() !== "file") {
    throw new Error("Selected element must be an input type=file.");
  }
  return {
    nodeId: ids[idx], multiple: attr.has("multiple"), disabled: attr.has("disabled"), selector, index: idx,
  };
}

async function confirmSelected(send: FileCdpSend, payload: Record<string, unknown>, expected: string[]): Promise<any> {
  const rows = await listInputs(send, String(payload.selector || "input[type=file]"));
  const idx = Number(payload.inputIndex ?? payload.input_index ?? 0);
  const row = rows[idx];
  if (!row || row.type !== "file") throw new Error("File input disappeared before selection could be verified.");
  const actual = row.selected.map((f: any) => String(f.name));
  const matches = actual.length === expected.length && actual.every((name: string, i: number) => name === expected[i]);
  return { status: matches ? "selected_in_browser" : "selection_unverified", verification: "dom_file_list", files: actual, matchesExpected: matches, serverUploadConfirmed: false };
}

function expectedNames(payload: Record<string, unknown>): string[] {
  const raw = payload.expectedNames ?? payload.fileNames ?? [];
  if (!Array.isArray(raw) || !raw.every(v => typeof v === "string")) throw new Error("expectedNames must be an array of file names.");
  return raw as string[];
}

export async function executeFileUploadCommand(
  command: FileUploadCommand, send: FileCdpSend, targetId: string,
  payload: Record<string, unknown>, cwd: string,
  delegateEvents?: () => Promise<any[]>,
): Promise<string> {
  if (command === "list_file_inputs") {
    const rows = await listInputs(send, String(payload.selector || "input[type=file]"));
    return JSON.stringify({ command, count: rows.length, inputs: rows });
  }
  if (command === "verify_upload") {
    const rows = await listInputs(send, String(payload.selector || "input[type=file]"));
    const idx = Number(payload.inputIndex ?? payload.input_index ?? 0);
    const entry = rows[idx];
    if (!entry) return JSON.stringify({ status: "input_not_found", serverUploadConfirmed: false });
    const expected = expectedNames(payload);
    const selectedNames = entry.selected.map((file: any) => file.name);
    const matchesExpected = expected.length > 0 && expected.length === selectedNames.length && expected.every((name, i) => name === selectedNames[i]);
    let pageEvidenceObserved = false;
    if (payload.successSelector) {
      const expression = "Boolean(document.querySelector(" + JSON.stringify(String(payload.successSelector)) + "))";
      pageEvidenceObserved = resultValue(await send("Runtime.evaluate", { expression, returnByValue: true })) === true;
    }
    return JSON.stringify({
      status: pageEvidenceObserved ? "page_evidence_observed" : matchesExpected ? "selected_in_browser" : "unverified",
      selectedNames, matchesExpected, pageEvidenceObserved, serverUploadConfirmed: false,
      note: "CDP FileList and page selector do not prove a server accepted or stored the upload.",
    });
  }
  if (command === "handle_file_chooser" && payload.nativeDialog === true) {
    const files = await validateUploadPaths(payload, cwd);
    const dialogResult = await handleNativeWindowsFileDialog(files, {
      confirmNativeDialog: payload.confirmNativeDialog === true,
      windowTitle: typeof payload.windowTitle === "string" ? payload.windowTitle : undefined,
    });
    try {
      const selected = await confirmSelected(send, payload, files.map(file => path.basename(file)));
      return JSON.stringify({
        ...dialogResult,
        status: selected.matchesExpected ? "selected_in_browser" : "native_dialog_closed_selection_unverified",
        browserSelection: selected,
      });
    } catch {
      return JSON.stringify({ ...dialogResult, status: "native_dialog_closed_selection_unverified",
        note: "Windows dialog closed, but the website file input was not independently verified." });
    }
  }
  if (command === "handle_file_chooser" && (payload.arm === true || (payload.files === undefined && payload.filePath === undefined && payload.filePaths === undefined && payload.paths === undefined))) {
    await send("Page.enable", {});
    await send("Page.setInterceptFileChooserDialog", { enabled: true });
    clearFileChooserEvent(targetId);
    return JSON.stringify({ status: "armed", note: "Trigger the webpage file chooser, then call handle_file_chooser with files. An already-open native Windows Open dialog cannot be controlled through CDP." });
  }
  const files = await validateUploadPaths(payload, cwd);
  let backendNodeId: number | undefined;
  if (command === "handle_file_chooser") {
    const managedEvent = chooserEvents.get(targetId);
    let event = managedEvent && Date.now() - managedEvent.time < 60_000 ? managedEvent : undefined;
    if (!event && delegateEvents) {
      const events = await delegateEvents();
      const latest = [...events].reverse().find(row => row?.method === "Page.fileChooserOpened");
      const backendNodeId = Number(latest?.backendNodeId ?? latest?.params?.backendNodeId);
      if (Number.isSafeInteger(backendNodeId) && backendNodeId > 0) event = {
        backendNodeId, mode: String(latest?.mode ?? latest?.params?.mode ?? ""), time: Date.now(),
      };
    }
    if (!event) throw new Error("No intercepted file chooser event. Call handle_file_chooser with arm:true before clicking the upload button; a native Open dialog already on screen needs OS-level automation.");
    if (files.length > 1 && event.mode === "selectSingle") throw new Error("Chooser accepts only one file.");
    backendNodeId = event.backendNodeId;
  }
  let input: Awaited<ReturnType<typeof getInput>> | undefined;
  if (backendNodeId === undefined) {
    input = await getInput(send, payload);
    if (input.disabled) throw new Error("File input is disabled.");
    if (!input.multiple && files.length > 1) throw new Error("File input does not support multiple files.");
  }
  await send("DOM.setFileInputFiles", {
    files,
    ...(backendNodeId ? { backendNodeId } : { nodeId: input!.nodeId }),
  });
  if (command === "handle_file_chooser") {
    clearFileChooserEvent(targetId);
    await send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => undefined);
  }
  const expected = files.map(f => path.basename(f));
  const result = await confirmSelected(send, payload, expected);
  return JSON.stringify({ command, ...result });
}
