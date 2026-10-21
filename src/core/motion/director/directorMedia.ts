import { readMotionAsset } from "../assets/motionAssets.js";
import { readMotionAudio, inspectMotionWav } from "../assets/motionAudio.js";
import type { MotionAudioTrack, MotionEdit, MotionProject } from "../schema/types.js";

export interface MotionDirectorMediaSelection {
  imageAssetId?: string;
  audioAssetId?: string;
  audioGain?: number;
}
export type VerifiedDirectorMedia = {
  image?: { id: string; width: number; height: number };
  audio?: { id: string; seconds: number; gain: number };
};
export function validateMediaOptions(selection: MotionDirectorMediaSelection): void {
  if (selection.imageAssetId !== undefined &&
    (typeof selection.imageAssetId !== "string" || !/^asset-[a-f0-9]{64}$/.test(selection.imageAssetId)))
    throw new Error("Invalid Motion Director image asset ID");
  if (selection.audioAssetId !== undefined &&
    (typeof selection.audioAssetId !== "string" || !/^audio-[a-f0-9]{64}$/.test(selection.audioAssetId)))
    throw new Error("Invalid Motion Director audio asset ID");
  if (selection.audioGain !== undefined &&
    (selection.audioAssetId === undefined || typeof selection.audioGain !== "number" ||
      !Number.isFinite(selection.audioGain) || selection.audioGain < 0 || selection.audioGain > 2))
    throw new Error("Invalid Motion Director audio gain (requires attached WAV, 0–2)");
}
/** Only immutable already-imported, hash-verified files in this workspace can be selected. */
export async function resolveDirectorMedia(workspace: string, selection: MotionDirectorMediaSelection):
Promise<VerifiedDirectorMedia> {
  validateMediaOptions(selection);
  const [imageBytes, audioBytes] = await Promise.all([
    selection.imageAssetId ? readMotionAsset(workspace, selection.imageAssetId) : undefined,
    selection.audioAssetId ? readMotionAudio(workspace, selection.audioAssetId) : undefined,
  ]);
  const image = imageBytes ? {
    id: selection.imageAssetId!, width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20),
  } : undefined;
  if (image && (image.width < 1 || image.width > 4096 || image.height < 1 || image.height > 4096 ||
      image.width * image.height > 4_000_000)) throw new Error("Invalid Motion Director image dimensions");
  const audio = audioBytes ? {
    id: selection.audioAssetId!, seconds: inspectMotionWav(audioBytes).seconds, gain: selection.audioGain ?? 1,
  } : undefined;
  return { ...(image ? { image } : {}), ...(audio ? { audio } : {}) };
}
export function imageLayer(media: NonNullable<VerifiedDirectorMedia["image"]>): MotionProject["composition"]["layers"][number] {
  const ratio = Math.min(570 / media.width, 330 / media.height);
  const width = Math.max(1, Math.round(media.width * ratio));
  const height = Math.max(1, Math.round(media.height * ratio));
  return {
    kind: "image", id: "director-media-image", assetId: media.id,
    x: Math.round(1920 - 148 - width), y: Math.round(80 + (330 - height) / 2),
    width, height, rotation: 0, opacity: 1, fill: "#FFFFFF",
    tracks: [{ property: "opacity", keyframes: [
      { frame: 0, value: 0, easing: "easeInOut" }, { frame: 10, value: 1, easing: "easeInOut" },
    ] }],
  };
}
function audioClip(audio: NonNullable<VerifiedDirectorMedia["audio"]>, durationFrames: number): MotionAudioTrack {
  return { assetId: audio.id, startFrame: 0, volume: audio.gain,
    fadeInFrames: Math.min(10, durationFrames),
    fadeOutFrames: Math.min(12, Math.round(audio.seconds * 30)) };
}
export function embedDirectorMedia(
  composition: MotionProject["composition"], verified: VerifiedDirectorMedia,
): MotionProject["composition"] {
  return {
    ...composition,
    ...(verified.audio ? { audioTracks: [audioClip(verified.audio, composition.durationFrames)] } : {}),
    layers: verified.image ? [imageLayer(verified.image), ...composition.layers] : composition.layers,
  };
}
export function revisionMediaEdits(
  project: MotionProject, verified: VerifiedDirectorMedia,
): MotionEdit[] {
  const edits: MotionEdit[] = [];
  if (verified.image) {
    if (project.composition.layers.some(layer => layer.id === "director-media-image")) {
      edits.push({ type: "remove-layer", layerId: "director-media-image" });
    }
    edits.push({ type: "add-layer", layer: imageLayer(verified.image), index: 0 });
  }
  if (verified.audio) {
    const clips = project.composition.audioTracks ??
      (project.composition.audio ? [project.composition.audio] : []);
    if (clips.length >= 4) throw new Error("Motion Director audio mixer already has four clips");
    edits.push({ type: "set-audio-tracks", audioTracks: [
      ...clips, audioClip(verified.audio, project.composition.durationFrames),
    ] });
  }
  return edits;
}
export function directorMediaLimitations(media: VerifiedDirectorMedia, durationSeconds: number): string[] {
  const limitations = ["Video footage, generated images, music synthesis and text-to-speech are not available."];
  if (media.audio && media.audio.seconds < durationSeconds - 0.2) {
    limitations.push("Attached WAV is shorter than the motion duration; it is not automatically looped.");
  }
  return limitations;
}
