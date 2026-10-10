import { describe, test, expect } from "vitest";
import {
  MEDIA_INSPECT_JS,
  formatMediaInspectionResult,
  MediaInspectionResult,
  executeInspectMediaDevices,
} from "../src/core/tools/chromeCdpMedia.js";

describe("chromeCdpMedia", () => {
  const sampleMediaResult: MediaInspectionResult = {
    url: "https://example.com/conference",
    origin: "https://example.com",
    permissions: {
      microphone: "granted",
      camera: "prompt",
      speakerSelection: "granted",
    },
    audioInputs: [
      {
        deviceId: "mic-default-id",
        kind: "audioinput",
        label: "Realtek High Definition Audio (Microphone)",
        groupId: "group-1",
      },
      {
        deviceId: "mic-usb-id",
        kind: "audioinput",
        label: "USB Condenser Microphone",
        groupId: "group-2",
      },
    ],
    audioOutputs: [
      {
        deviceId: "speaker-default-id",
        kind: "audiooutput",
        label: "Realtek High Definition Audio (Speakers/Headphones)",
        groupId: "group-1",
      },
      {
        deviceId: "hdmi-out-id",
        kind: "audiooutput",
        label: "NVIDIA High Definition Audio (HDMI)",
        groupId: "group-3",
      },
    ],
    videoInputs: [
      {
        deviceId: "camera-webcam-id",
        kind: "videoinput",
        label: "Integrated Webcam HD (04f2:b626)",
        groupId: "group-4",
      },
    ],
    sinkIdSupported: true,
    audioContextState: "running",
    autoplayPolicy: {
      mediaElement: "allowed",
      audioContext: "allowed",
    },
    mediaElements: [
      {
        tag: "audio",
        selector: "#conference-audio",
        isPlaying: true,
        paused: false,
        muted: false,
        volume: 0.85,
        currentTime: 42.5,
        duration: 120.0,
        sinkId: "speaker-default-id",
        readyState: 4,
        currentSrc: "blob:https://example.com/audio-stream-123",
      },
      {
        tag: "video",
        selector: ".promo-video",
        isPlaying: false,
        paused: true,
        muted: true,
        volume: 1.0,
        currentTime: 0,
        duration: 60,
        sinkId: "",
        readyState: 2,
        currentSrc: "https://example.com/video.mp4",
      },
    ],
  };

  test("MEDIA_INSPECT_JS includes enumerateDevices, permissions, and media element inspection", () => {
    expect(MEDIA_INSPECT_JS).toContain("navigator.mediaDevices.enumerateDevices");
    expect(MEDIA_INSPECT_JS).toContain("navigator.permissions.query");
    expect(MEDIA_INSPECT_JS).toContain("microphone");
    expect(MEDIA_INSPECT_JS).toContain("audioinput");
    expect(MEDIA_INSPECT_JS).toContain("audiooutput");
    expect(MEDIA_INSPECT_JS).toContain("videoinput");
    expect(MEDIA_INSPECT_JS).toContain("setSinkId");
    expect(MEDIA_INSPECT_JS).toContain("AudioContext");
    expect(MEDIA_INSPECT_JS).toContain("getAutoplayPolicy");
  });

  test("formatMediaInspectionResult renders human-readable sections for speakers, mics, cameras, and playback", () => {
    const formatted = formatMediaInspectionResult(sampleMediaResult);

    expect(formatted).toContain("control_chrome_cdp: media device inspection for 'https://example.com/conference':");
    expect(formatted).toContain("Permissions:");
    expect(formatted).toContain("Microphone: GRANTED");
    expect(formatted).toContain("Camera: PROMPT");
    expect(formatted).toContain("Speaker Selection: GRANTED");

    expect(formatted).toContain("Audio Input Devices / Microphones (2):");
    expect(formatted).toContain('1. "Realtek High Definition Audio (Microphone)" [mic-default-id] (group: group-1)');
    expect(formatted).toContain('2. "USB Condenser Microphone" [mic-usb-id] (group: group-2)');

    expect(formatted).toContain("Audio Output Devices / Speakers (2):");
    expect(formatted).toContain('1. "Realtek High Definition Audio (Speakers/Headphones)" [speaker-default-id] (group: group-1)');
    expect(formatted).toContain('2. "NVIDIA High Definition Audio (HDMI)" [hdmi-out-id] (group: group-3)');

    expect(formatted).toContain("Video Input Devices / Cameras (1):");
    expect(formatted).toContain('1. "Integrated Webcam HD (04f2:b626)" [camera-webcam-id] (group: group-4)');

    expect(formatted).toContain("Audio Output Routing (setSinkId): SUPPORTED");
    expect(formatted).toContain("AudioContext State: RUNNING");
    expect(formatted).toContain("Autoplay Policy: mediaElement=allowed, audioContext=allowed");

    expect(formatted).toContain("Active Media Elements (2):");
    expect(formatted).toContain('- <audio#conference-audio>: [PLAYING] volume=85%, muted=false, sinkId="speaker-default-id"');
    expect(formatted).toContain('- <video.promo-video>: [PAUSED] volume=100%, muted=true, sinkId="(default)"');
  });

  test("executeInspectMediaDevices executes Runtime.evaluate with MEDIA_INSPECT_JS and grants permissions when requested", async () => {
    const sentCalls: Array<{ method: string; params: any }> = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      sentCalls.push({ method, params });
      if (method === "Browser.grantPermissions") {
        return {};
      }
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: sampleMediaResult,
          },
        };
      }
      return {};
    };

    const target = {
      id: "T1",
      title: "Conference Page",
      url: "https://example.com/conference",
      type: "page",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/page/T1",
    };

    const output = await executeInspectMediaDevices(mockCdpSend, target, {
      grantPermissions: true,
    });

    expect(sentCalls.some((c) => c.method === "Browser.grantPermissions")).toBe(true);
    const grantCall = sentCalls.find((c) => c.method === "Browser.grantPermissions");
    expect(grantCall?.params.permissions).toEqual(["audioCapture", "videoCapture", "speakerSelection"]);
    expect(grantCall?.params.origin).toBe("https://example.com");

    expect(output).toContain("Audio Input Devices / Microphones (2):");
    expect(output).toContain("Audio Output Devices / Speakers (2):");
    expect(output).toContain("Audio Output Routing (setSinkId): SUPPORTED");
  });

  test("executeInspectMediaDevices resets permissions when resetPermissions: true is specified", async () => {
    const sentCalls: Array<{ method: string; params: any }> = [];
    const mockCdpSend = async (_target: any, method: string, params: any) => {
      sentCalls.push({ method, params });
      if (method === "Runtime.evaluate") {
        return { result: { value: sampleMediaResult } };
      }
      return {};
    };

    const target = {
      id: "T1",
      title: "Conference Page",
      url: "https://example.com/conference",
      type: "page",
      webSocketDebuggerUrl: "ws://127.0.0.1:9222/page/T1",
    };

    await executeInspectMediaDevices(mockCdpSend, target, {
      resetPermissions: true,
    });

    expect(sentCalls.some((c) => c.method === "Browser.resetPermissions")).toBe(true);
  });
});
