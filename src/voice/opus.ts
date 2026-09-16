/**
 * PCM to Opus, in pure JavaScript.
 *
 * `@discordjs/voice` can send Opus packets directly with
 * `StreamType.Opus`. Staying on that path means the bot never needs FFmpeg:
 * the cue sounds are pre-encoded once, in process, and the audio pipeline has
 * no external binary in it at all. That matters because the production host
 * does not ship FFmpeg, and shelling out to it is the usual reason a Discord
 * bot's audio silently fails in production.
 *
 * `opusscript` is used rather than a native binding because it has no
 * prebuilt-ABI requirement, so a Node major upgrade cannot break it.
 */

import OpusScript from "opusscript";

import { SAMPLE_RATE, toPcm16 } from "./wav";

/** Opus frames are 20 ms. */
export const FRAME_SAMPLES = SAMPLE_RATE / 50;

export class OpusUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpusUnavailableError";
  }
}

/**
 * Linearly resample to the encoder's rate.
 *
 * Our own assets are always authored at 48 kHz, so this exists only so that a
 * replaced or hand-edited asset degrades to slightly wrong pitch rather than
 * failing outright.
 */
export function resampleLinear(
  samples: Float64Array,
  fromRate: number,
  toRate: number,
): Float64Array {
  if (fromRate === toRate || samples.length === 0) return samples;

  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.round(samples.length / ratio));
  const output = new Float64Array(length);

  for (let index = 0; index < length; index += 1) {
    const position = index * ratio;
    const lower = Math.floor(position);
    const upper = Math.min(lower + 1, samples.length - 1);
    const fraction = position - lower;

    const a = samples[lower] ?? 0;
    const b = samples[upper] ?? a;
    output[index] = a + (b - a) * fraction;
  }

  return output;
}

/**
 * Encode normalised samples into Opus packets.
 *
 * A trailing partial frame is zero-padded, because a short final frame is not
 * a valid Opus packet.
 *
 * The frame size must be passed explicitly: `opusscript` forwards it straight
 * to the native call, and an omitted value surfaces as an opaque
 * "Encode error: Bad argument".
 */
export function encodeToOpusFrames(
  samples: Float64Array,
  sampleRate: number = SAMPLE_RATE,
): Buffer[] {
  const frameBytes = FRAME_SAMPLES * 2;
  const pcm = Buffer.alloc(frameBytes);

  let encoder: OpusScript;
  try {
    encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
  } catch (error) {
    throw new OpusUnavailableError(
      "the pure-JS Opus encoder could not be initialised; sound will be skipped",
      { cause: error },
    );
  }

  const resampled =
    sampleRate === SAMPLE_RATE ? samples : resampleLinear(samples, sampleRate, SAMPLE_RATE);
  const frames: Buffer[] = [];

  try {
    for (let offset = 0; offset < resampled.length; offset += FRAME_SAMPLES) {
      pcm.fill(0);
      for (let index = 0; index < FRAME_SAMPLES; index += 1) {
        pcm.writeInt16LE(toPcm16(resampled[offset + index] ?? 0), index * 2);
      }
      frames.push(encoder.encode(pcm, FRAME_SAMPLES));
    }
  } catch (error) {
    throw new OpusUnavailableError("the Opus encoder failed while encoding a cue sound", {
      cause: error,
    });
  } finally {
    // opusscript allocates outside the JS heap; release it deterministically.
    try {
      encoder.delete();
    } catch {
      // A failed teardown must not mask a successful encode.
    }
  }

  return frames;
}
