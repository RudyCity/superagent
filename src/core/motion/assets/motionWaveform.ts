import { inspectMotionWav } from "./motionAudio.js";

export interface MotionWaveform {
  peaks: number[];
  seconds: number;
  sampleRate: number;
  channels: number;
}

/** Small bounded waveform envelope for authenticated WAV assets. Never returns PCM bytes. */
export function summarizeMotionWav(bytes: Buffer, buckets = 96): MotionWaveform {
  const { sampleRate, channels, seconds } = inspectMotionWav(bytes);
  if (!Number.isSafeInteger(buckets) || buckets < 8 || buckets > 256) {
    throw new Error("Invalid Motion waveform resolution");
  }
  const frameCount = (bytes.length - 44) / (channels * 2);
  const peaks = new Array<number>(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket++) {
    const first = Math.floor(bucket * frameCount / buckets);
    const last = Math.floor((bucket + 1) * frameCount / buckets);
    let peak = 0;
    for (let frame = first; frame < last; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = bytes.readInt16LE(44 + (frame * channels + channel) * 2);
        peak = Math.max(peak, Math.abs(sample) / 32768);
      }
    }
    peaks[bucket] = Math.round(peak * 1000) / 1000;
  }
  return { peaks, seconds, sampleRate, channels };
}
