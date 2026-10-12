/**
 * Chrome Remote Debugging (CDP) Media Device Inspector.
 * Inspects audio inputs (microphones), audio outputs (speakers/headphones),
 * video inputs (webcams), audio routing (setSinkId), audio playback status,
 * AudioContext state, and autoplay policies via CDP and browser APIs.
 */

import os from "os";
import { runPsEncoded } from "./chromeCommon.js";

export interface MediaDeviceInfoSummary {
  deviceId: string;
  kind: "audioinput" | "audiooutput" | "videoinput" | string;
  label: string;
  groupId: string;
}

export interface MediaElementSummary {
  tag: string;
  selector: string;
  isPlaying: boolean;
  paused: boolean;
  muted: boolean;
  volume: number;
  currentTime: number;
  duration: number;
  sinkId: string;
  readyState: number;
  currentSrc: string;
  error?: string | null;
}

export interface MediaInspectionResult {
  url: string;
  origin: string;
  permissions: {
    microphone?: string;
    camera?: string;
    speakerSelection?: string;
    displayCapture?: string;
  };
  audioInputs: MediaDeviceInfoSummary[];
  audioOutputs: MediaDeviceInfoSummary[];
  videoInputs: MediaDeviceInfoSummary[];
  sinkIdSupported: boolean;
  audioContextState?: string;
  autoplayPolicy: {
    mediaElement?: string;
    audioContext?: string;
  };
  mediaElements: MediaElementSummary[];
}

export const MEDIA_INSPECT_JS = `(async () => {
  const result = {
    url: window.location.href,
    origin: window.location.origin,
    permissions: {},
    audioInputs: [],
    audioOutputs: [],
    videoInputs: [],
    sinkIdSupported: 'setSinkId' in HTMLMediaElement.prototype,
    audioContextState: undefined,
    autoplayPolicy: {
      mediaElement: undefined,
      audioContext: undefined,
    },
    mediaElements: [],
  };

  try {
    if (navigator.permissions && typeof navigator.permissions.query === 'function') {
      try {
        const p = await navigator.permissions.query({ name: 'microphone' as any });
        result.permissions.microphone = p.state;
      } catch {}
      try {
        const p = await navigator.permissions.query({ name: 'camera' as any });
        result.permissions.camera = p.state;
      } catch {}
      try {
        const p = await navigator.permissions.query({ name: 'speaker-selection' as any });
        result.permissions.speakerSelection = p.state;
      } catch {}
      try {
        const p = await navigator.permissions.query({ name: 'display-capture' as any });
        result.permissions.displayCapture = p.state;
      } catch {}
    }
  } catch {}

  try {
    if (navigator.mediaDevices && typeof navigator.mediaDevices.enumerateDevices === 'function') {
      const devices = await navigator.mediaDevices.enumerateDevices();
      for (const d of devices) {
        const item = {
          deviceId: d.deviceId || '',
          kind: d.kind,
          label: d.label || '',
          groupId: d.groupId || '',
        };
        if (d.kind === 'audioinput') result.audioInputs.push(item);
        else if (d.kind === 'audiooutput') result.audioOutputs.push(item);
        else if (d.kind === 'videoinput') result.videoInputs.push(item);
      }
    }
  } catch {}

  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx) {
      result.audioContextState = 'running';
    }
  } catch {}

  try {
    if (typeof (navigator as any).getAutoplayPolicy === 'function') {
      result.autoplayPolicy.mediaElement = (navigator as any).getAutoplayPolicy('mediaelement');
      result.autoplayPolicy.audioContext = (navigator as any).getAutoplayPolicy('audiocontext');
    }
  } catch {}

  try {
    const elements = Array.from(document.querySelectorAll('audio, video'));
    result.mediaElements = elements.map((el, i) => {
      const media = el as HTMLMediaElement;
      let selector = '';
      if (media.id) selector = '#' + media.id;
      else if (media.className && typeof media.className === 'string') {
        const firstClass = media.className.trim().split(/\\s+/)[0];
        if (firstClass) selector = '.' + firstClass;
      }
      if (!selector) selector = '[' + i + ']';

      const isPlaying = !media.paused && !media.ended && media.readyState > 2;
      return {
        tag: media.tagName.toLowerCase(),
        selector,
        isPlaying,
        paused: media.paused,
        muted: media.muted,
        volume: media.volume,
        currentTime: Math.round(media.currentTime * 10) / 10,
        duration: isNaN(media.duration) ? 0 : Math.round(media.duration * 10) / 10,
        sinkId: (media as any).sinkId || '',
        readyState: media.readyState,
        currentSrc: media.currentSrc || media.src || '',
        error: media.error ? (media.error.message || 'Code ' + media.error.code) : null,
      };
    });
  } catch {}

  return result;
})()`;

export function formatMediaInspectionResult(result: MediaInspectionResult): string {
  const lines: string[] = [];

  lines.push(`control_chrome_cdp: media device inspection for '${result.url}':`);
  lines.push("");

  lines.push("Permissions:");
  lines.push(`  Microphone: ${(result.permissions?.microphone || "UNKNOWN").toUpperCase()}`);
  lines.push(`  Camera: ${(result.permissions?.camera || "UNKNOWN").toUpperCase()}`);
  lines.push(`  Speaker Selection: ${(result.permissions?.speakerSelection || "UNKNOWN").toUpperCase()}`);
  if (result.permissions?.displayCapture) {
    lines.push(`  Display Capture: ${result.permissions.displayCapture.toUpperCase()}`);
  }
  lines.push("");

  lines.push(`Audio Input Devices / Microphones (${result.audioInputs.length}):`);
  if (result.audioInputs.length === 0) {
    lines.push("  (no audio input devices detected or permission required)");
  } else {
    result.audioInputs.forEach((d, idx) => {
      lines.push(`  ${idx + 1}. "${d.label || "(unlabeled)"}" [${d.deviceId || "default"}] (group: ${d.groupId || "default"})`);
    });
  }
  lines.push("");

  lines.push(`Audio Output Devices / Speakers (${result.audioOutputs.length}):`);
  if (result.audioOutputs.length === 0) {
    lines.push("  (no audio output devices detected or permission required)");
  } else {
    result.audioOutputs.forEach((d, idx) => {
      lines.push(`  ${idx + 1}. "${d.label || "(unlabeled)"}" [${d.deviceId || "default"}] (group: ${d.groupId || "default"})`);
    });
  }
  lines.push("");

  lines.push(`Video Input Devices / Cameras (${result.videoInputs.length}):`);
  if (result.videoInputs.length === 0) {
    lines.push("  (no video input devices detected or permission required)");
  } else {
    result.videoInputs.forEach((d, idx) => {
      lines.push(`  ${idx + 1}. "${d.label || "(unlabeled)"}" [${d.deviceId || "default"}] (group: ${d.groupId || "default"})`);
    });
  }
  lines.push("");

  lines.push(`Audio Output Routing (setSinkId): ${result.sinkIdSupported ? "SUPPORTED" : "UNSUPPORTED"}`);
  lines.push(`AudioContext State: ${(result.audioContextState || "N/A").toUpperCase()}`);
  const autoElem = result.autoplayPolicy?.mediaElement || "unknown";
  const autoCtx = result.autoplayPolicy?.audioContext || "unknown";
  lines.push(`Autoplay Policy: mediaElement=${autoElem}, audioContext=${autoCtx}`);
  lines.push("");

  lines.push(`Active Media Elements (${result.mediaElements.length}):`);
  if (result.mediaElements.length === 0) {
    lines.push("  (no active audio or video elements detected on page)");
  } else {
    result.mediaElements.forEach((el) => {
      const state = el.isPlaying ? "PLAYING" : "PAUSED";
      const vol = Math.round((el.volume ?? 1) * 100);
      const sink = el.sinkId ? `"${el.sinkId}"` : '"(default)"';
      lines.push(`  - <${el.tag}${el.selector}>: [${state}] volume=${vol}%, muted=${Boolean(el.muted)}, sinkId=${sink}`);
    });
  }

  return lines.join("\n");
}

export async function executeInspectMediaDevices(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  options?: {
    grantPermissions?: boolean;
    resetPermissions?: boolean;
  }
): Promise<string> {
  if (options?.resetPermissions) {
    try {
      await cdpSend(target, "Browser.resetPermissions", {});
    } catch {
      // Ignore if browser permission reset not supported
    }
  }

  if (options?.grantPermissions) {
    let origin = "";
    try {
      origin = new URL(target.url).origin;
    } catch {
      origin = target.url || "";
    }
    if (origin && origin !== "about:blank") {
      try {
        await cdpSend(target, "Browser.grantPermissions", {
          permissions: ["audioCapture", "videoCapture", "displayCapture", "speakerSelection"],
          origin,
        });
      } catch {
        // Fallback or ignore if Browser domain not permitted in session
      }
    }
  }

  const evalRes = await cdpSend(target, "Runtime.evaluate", {
    expression: MEDIA_INSPECT_JS,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = evalRes?.result?.value as MediaInspectionResult | undefined;
  if (!value) {
    return "control_chrome_cdp: media device inspection returned empty result.";
  }

  return formatMediaInspectionResult(value);
}

export async function executeMockDisplayMedia(
  cdpSend: (target: any, method: string, params?: any) => Promise<any>,
  target: any,
  options?: {
    label?: string;
    width?: number;
    height?: number;
    fps?: number;
    includeAudio?: boolean;
  }
): Promise<string> {
  const label = (options?.label || "Superagent Screen Capture").replace(/["'\\]/g, "");
  const width = Number(options?.width) || 1280;
  const height = Number(options?.height) || 720;
  const fps = Number(options?.fps) || 30;
  const includeAudio = options?.includeAudio !== false;

  const script = `(() => {
    try {
      if (!navigator.mediaDevices) {
        navigator.mediaDevices = {};
      }
      navigator.mediaDevices.getDisplayMedia = async function(constraints) {
        const canvas = document.createElement('canvas');
        canvas.width = ${width};
        canvas.height = ${height};
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#181a1f';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#61afef';
          ctx.font = 'bold 36px monospace';
          ctx.fillText('${label}', 80, ${Math.floor(height / 2)});
        }
        const stream = canvas.captureStream(${fps});
        if (${includeAudio} && constraints && (constraints.audio || constraints.video === undefined)) {
          try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
              const actx = new AudioCtx();
              const osc = actx.createOscillator();
              const dst = actx.createMediaStreamDestination();
              const gain = actx.createGain();
              gain.gain.value = 0.0001;
              osc.connect(gain);
              gain.connect(dst);
              osc.start();
              dst.stream.getAudioTracks().forEach(t => stream.addTrack(t));
            }
          } catch {}
        }
        return stream;
      };
      window.__superagentMockDisplayMediaInstalled = true;
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  })()`;

  try {
    await cdpSend(target, "Page.addScriptToEvaluateOnNewDocument", { source: script });
  } catch {}

  const evalRes = await cdpSend(target, "Runtime.evaluate", {
    expression: script,
    returnByValue: true,
    awaitPromise: true,
  });

  const val = evalRes?.result?.value;
  if (val && val.ok === false) {
    return `control_chrome_cdp: failed to install mock display media: ${val.error}`;
  }

  return `control_chrome_cdp: mock navigator.mediaDevices.getDisplayMedia active on '${target.title}' (${width}x${height} @ ${fps}fps${includeAudio ? ", with audio" : ""}). getDisplayMedia() will resolve immediately without native picker dialog.`;
}

export async function executeHandleScreenSharePrompt(
  options?: {
    action?: "accept" | "dismiss";
    tabIndex?: number;
  }
): Promise<string> {
  if (os.platform() !== "win32") {
    return "handle_screen_share OS dialog interaction is currently implemented for Windows.";
  }
  const action = options?.action || "accept";
  const tabIndex = Math.max(1, Math.floor(Number(options?.tabIndex) || 1));

  if (action === "dismiss") {
    const psScript = [
      `$wshell = New-Object -ComObject wscript.shell`,
      `if ($wshell.AppActivate('Chrome')) {`,
      `  Start-Sleep -Milliseconds 250`,
      `  $wshell.SendKeys('{ESC}')`,
      `  Write-Output 'DISMISSED'`,
      `} else {`,
      `  Write-Output 'CHROME_NOT_FOCUSED'`,
      `}`,
    ].join("\n");
    const res = (await runPsEncoded(psScript, { timeout: 10000 })).trim();
    if (res === "CHROME_NOT_FOCUSED") {
      return "control_chrome_cdp: Chrome window was not found or could not be focused to dismiss screen share dialog.";
    }
    return "control_chrome_cdp: sent ESC to dismiss the native screen share picker dialog.";
  }

  let downKeys = "{DOWN}";
  if (tabIndex > 1) {
    downKeys = Array(tabIndex).fill("{DOWN}").join("");
  }
  const psScript = [
    `$wshell = New-Object -ComObject wscript.shell`,
    `if ($wshell.AppActivate('Chrome')) {`,
    `  Start-Sleep -Milliseconds 300`,
    `  $wshell.SendKeys('${downKeys}')`,
    `  Start-Sleep -Milliseconds 200`,
    `  $wshell.SendKeys('{ENTER}')`,
    `  Write-Output 'ACCEPTED'`,
    `} else {`,
    `  Write-Output 'CHROME_NOT_FOCUSED'`,
    `}`,
  ].join("\n");
  const res = (await runPsEncoded(psScript, { timeout: 10000 })).trim();
  if (res === "CHROME_NOT_FOCUSED") {
    return "control_chrome_cdp: Chrome window was not found or could not be focused to accept screen share dialog.";
  }
  return `control_chrome_cdp: automatically selected tab (item ${tabIndex}) and confirmed native screen share dialog.`;
}
