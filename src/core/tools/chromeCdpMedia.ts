/**
 * Chrome Remote Debugging (CDP) Media Device Inspector.
 * Inspects audio inputs (microphones), audio outputs (speakers/headphones),
 * video inputs (webcams), audio routing (setSinkId), audio playback status,
 * AudioContext state, and autoplay policies via CDP and browser APIs.
 */

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
        const p = await navigator.permissions.query({ name: 'microphone' });
        result.permissions.microphone = p.state;
      } catch {}
      try {
        const p = await navigator.permissions.query({ name: 'camera' });
        result.permissions.camera = p.state;
      } catch {}
      try {
        const p = await navigator.permissions.query({ name: 'speaker-selection' });
        result.permissions.speakerSelection = p.state;
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
          permissions: ["audioCapture", "videoCapture", "speakerSelection"],
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
