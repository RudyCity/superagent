import { readMotionAsset } from "../assets/motionAssets.js";
import { readMotionAudio, inspectMotionWav } from "../assets/motionAudio.js";
import type { MotionAudioTrack, MotionEdit, MotionProject } from "../schema/types.js";

export interface MotionDirectorMediaSelection {
  imageAssetId?: string;
  sceneImageAssetIds?: string[];
  audioAssetId?: string;
  audioGain?: number;
  audioLoop?: boolean;
}
export type VerifiedDirectorMedia = {
  image?: { id: string; width: number; height: number };
  sceneImages?: Array<{ id: string; width: number; height: number }>;
  audio?: { id: string; seconds: number; gain: number; loop: boolean };
  voiceover?: { id: string; seconds: number; gain: number };
};
export function validateMediaOptions(selection: MotionDirectorMediaSelection): void {
  if (selection.imageAssetId !== undefined &&
    (typeof selection.imageAssetId !== "string" || !/^asset-[a-f0-9]{64}$/.test(selection.imageAssetId)))
    throw new Error("Invalid Motion Director image asset ID");
  if (selection.sceneImageAssetIds !== undefined &&
      (!Array.isArray(selection.sceneImageAssetIds) || selection.sceneImageAssetIds.length < 1 ||
       selection.sceneImageAssetIds.length > 3 || selection.imageAssetId !== undefined ||
       selection.sceneImageAssetIds.some(id => typeof id !== "string" || !/^asset-[a-f0-9]{64}$/.test(id)))) {
    throw new Error("Invalid Motion Director scene image IDs (1-3 assets, no legacy image ID mix)");
  }
  if (selection.audioAssetId !== undefined &&
    (typeof selection.audioAssetId !== "string" || !/^audio-[a-f0-9]{64}$/.test(selection.audioAssetId)))
    throw new Error("Invalid Motion Director audio asset ID");
  if (selection.audioLoop !== undefined &&
      (typeof selection.audioLoop !== "boolean" || !selection.audioAssetId)) {
    throw new Error("Invalid Motion Director audio loop requires a selected WAV");
  }
  if (selection.audioGain !== undefined &&
    (selection.audioAssetId === undefined || typeof selection.audioGain !== "number" ||
      !Number.isFinite(selection.audioGain) || selection.audioGain < 0 || selection.audioGain > 2))
    throw new Error("Invalid Motion Director audio gain (requires attached WAV, 0–2)");
}
/** Only immutable already-imported, hash-verified files in this workspace can be selected. */
export async function resolveDirectorMedia(workspace: string, selection: MotionDirectorMediaSelection):
Promise<VerifiedDirectorMedia> {
  validateMediaOptions(selection);
  const [imageBytes, sceneImageBytes, audioBytes] = await Promise.all([
    selection.imageAssetId ? readMotionAsset(workspace, selection.imageAssetId) : undefined,
    selection.sceneImageAssetIds ? Promise.all(selection.sceneImageAssetIds.map(id => readMotionAsset(workspace, id))) : undefined,
    selection.audioAssetId ? readMotionAudio(workspace, selection.audioAssetId) : undefined,
  ]);
  const image = imageBytes ? {
    id: selection.imageAssetId!, width: imageBytes.readUInt32BE(16), height: imageBytes.readUInt32BE(20),
  } : undefined;
  if (image && (image.width < 1 || image.width > 4096 || image.height < 1 || image.height > 4096 ||
      image.width * image.height > 4_000_000)) throw new Error("Invalid Motion Director image dimensions");
  const sceneImages = sceneImageBytes?.map((bytes, i) => ({
    id: selection.sceneImageAssetIds![i], width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
  }));
  if (sceneImages?.some(item => item.width < 1 || item.width > 4096 || item.height < 1 ||
      item.height > 4096 || item.width * item.height > 4_000_000)) {
    throw new Error("Invalid Motion Director scene image dimensions");
  }
  const audio = audioBytes ? {
    id: selection.audioAssetId!, seconds: inspectMotionWav(audioBytes).seconds, gain: selection.audioGain ?? 1, loop: selection.audioLoop === true,
  } : undefined;
  return { ...(image ? { image } : {}), ...(sceneImages ? { sceneImages } : {}), ...(audio ? { audio } : {}) };
}
export function imageLayer(
  media: NonNullable<VerifiedDirectorMedia["image"]>,
  scene?: { index: number; opacityTracks: MotionProject["composition"]["layers"][number]["tracks"] },
  aspect?: { width: number; height: number },
): MotionProject["composition"]["layers"][number] {
  const tall = aspect !== undefined && aspect.height > aspect.width;
  const square = aspect !== undefined && aspect.height === aspect.width;
  const limitWidth = tall ? 850 : square ? 400 : 570;
  const limitHeight = tall ? 650 : 330;
  const ratio = Math.min(limitWidth / media.width, limitHeight / media.height);
  const width = Math.max(1, Math.round(media.width * ratio));
  const height = Math.max(1, Math.round(media.height * ratio));
  return {
    kind: "image", id: scene ? "director-media-scene-" + scene.index : "director-media-image", assetId: media.id,
    x: tall ? Math.round((aspect!.width - width) / 2) :
      Math.round((aspect?.width ?? 1920) - (square ? 90 : 148) - width),
    y: Math.round((tall ? 200 : 80) + (limitHeight - height) / 2),
    width, height, rotation: 0, opacity: 1, fill: "#FFFFFF",
    tracks: scene ? structuredClone(scene.opacityTracks) : [{ property: "opacity", keyframes: [
      { frame: 0, value: 0, easing: "easeInOut" }, { frame: 10, value: 1, easing: "easeInOut" },
    ] }],
  };
}
function audioClip(audio: NonNullable<VerifiedDirectorMedia["audio"]>, durationFrames: number): MotionAudioTrack {
  return { assetId: audio.id, startFrame: 0, volume: audio.gain,
    fadeInFrames: Math.min(10, durationFrames),
    fadeOutFrames: Math.min(12, Math.round(audio.seconds * 30)),
    ...(audio.loop ? { loop: true } : {}),
    role: "music" };
}
export function sceneImageLayers(
  composition: MotionProject["composition"], sceneImages: NonNullable<VerifiedDirectorMedia["sceneImages"]>,
): MotionProject["composition"]["layers"] {
  const scenes = composition.layers
    .filter(layer => layer.kind === "text" && /^scene-\d+-title$/.test(layer.id))
    .sort((a, b) => Number(a.id.split("-")[1]) - Number(b.id.split("-")[1]));
  if (sceneImages.length > scenes.length) throw new Error("Invalid Motion Director scene image count exceeds storyboard");
  return sceneImages.map((media, i) => {
    const title = scenes[i];
    if (!title) throw new Error("Invalid Motion Director missing image scene");
    if (!title.tracks.some(track => track.property === "opacity")) {
      throw new Error("Invalid Motion Director missing scene opacity timing");
    }
    return imageLayer(media, { index: i, opacityTracks: title.tracks.filter(track => track.property === "opacity") },
      { width: composition.width, height: composition.height });
  });
}
export function embedDirectorMedia(
  composition: MotionProject["composition"], verified: VerifiedDirectorMedia,
): MotionProject["composition"] {
  return {
    ...composition,
    ...(verified.audio || verified.voiceover ? { audioTracks: [
      ...(verified.audio ? [audioClip(verified.audio, composition.durationFrames)] : []),
      ...(verified.voiceover ? [{ ...audioClip({ ...verified.voiceover, loop: false }, composition.durationFrames), role: "voiceover" as const }] : []),
    ] } : {}),
    layers: [...(verified.image ? [imageLayer(verified.image, undefined, { width: composition.width, height: composition.height })] : []),
      ...(verified.sceneImages ? sceneImageLayers(composition, verified.sceneImages) : []),
      ...composition.layers],
  };
}
export function revisionMediaEdits(
  project: MotionProject, verified: VerifiedDirectorMedia,
): MotionEdit[] {
  const edits: MotionEdit[] = [];
  if (verified.image || verified.sceneImages) {
    for (const layer of project.composition.layers) {
      if (layer.id === "director-media-image" || /^director-media-scene-[0-2]$/.test(layer.id)) {
        edits.push({ type: "remove-layer", layerId: layer.id });
      }
    }
    const images = verified.image ? [imageLayer(verified.image, undefined, {
      width: project.composition.width, height: project.composition.height,
    })] :
      sceneImageLayers(project.composition, verified.sceneImages!);
    for (let i = 0; i < images.length; i++) edits.push({ type: "add-layer", layer: images[i], index: i });
  }
  if (verified.audio || verified.voiceover) {
    const clips = project.composition.audioTracks ??
      (project.composition.audio ? [project.composition.audio] : []);
    const incoming = [
      ...(verified.audio ? [audioClip(verified.audio, project.composition.durationFrames)] : []),
      ...(verified.voiceover ? [{ ...audioClip({ ...verified.voiceover, loop: false }, project.composition.durationFrames), role: "voiceover" as const }] : []),
    ];
    if (clips.length + incoming.length > 4) throw new Error("Motion Director audio mixer already has four clips");
    edits.push({ type: "set-audio-tracks", audioTracks: [...clips, ...incoming] });
  }
  return edits;
}
export function directorMediaLimitations(media: VerifiedDirectorMedia, durationSeconds: number): string[] {
  const limitations = ["Video footage, generated images and music synthesis are not available. Local TTS requires an operator-installed Piper voice model."];
  if (media.audio && !media.audio.loop && media.audio.seconds < durationSeconds - 0.2) {
    limitations.push("Attached WAV is shorter than the motion duration; it is not automatically looped.");
  }
  return limitations;
}
