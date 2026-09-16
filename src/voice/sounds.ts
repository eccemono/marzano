/**
 * The cue sounds, decoded and volume-scaled once per (sound, volume) pair.
 *
 * Decoding is cached because it is the expensive part, and volume is part of the
 * cache key because volume is applied to the samples rather than to any encoded
 * output.
 *
 * Cue playback hands the raw samples to the audio pipeline (`StreamType.Raw`)
 * rather than pre-encoding them: a pre-encoded Opus packet stream is drained in
 * milliseconds instead of being paced to the length of the audio. `frames()`
 * still exists because the `/test` audio diagnostic needs it to exercise that
 * path deliberately.
 *
 * No failure in here is ever allowed to throw at the caller: a missing asset, an
 * unusable encoder or a corrupt file degrades to silence, and the session
 * carries on. Sound is a nicety, not the product.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../logger";

import { encodeToOpusFrames } from "./opus";
import { applyVolume } from "./tones";
import { SAMPLE_RATE, decodeWav } from "./wav";

/** The cue played once at session start. */
export const START_CUE = "start";

/** The bell played at every stage boundary, including the first. */
export const BELL = "bell";

export type SoundName = typeof START_CUE | typeof BELL;

export const SOUND_NAMES: readonly SoundName[] = [START_CUE, BELL];

export interface SoundLoadReport {
  available: SoundName[];
  unavailable: { sound: SoundName; reason: string }[];
}

export interface SoundLibrary {
  /**
   * Raw PCM samples for a sound at the given volume (0-100).
   *
   * Returns `null` when the sound should not be played - either because the
   * volume is zero or because the sound could not be prepared.
   */
  samples(sound: SoundName, volumePercent: number): Float64Array | null;
  /**
   * The same audio encoded to Opus packets.
   *
   * Only the audio diagnostic uses this; cue playback streams raw samples.
   */
  frames(sound: SoundName, volumePercent: number): readonly Buffer[] | null;
  /** Eagerly prepare every sound at the default volume and report the outcome. */
  preload(): SoundLoadReport;
}

export interface SoundLibraryOptions {
  /** Directory holding `start.wav` and `bell.wav`. */
  directory: string;
  logger: Logger;
  /** Injectable for tests. */
  readFile?: (path: string) => Buffer;
}

interface PreparedSound {
  samples: Float64Array;
  sampleRate: number;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSoundLibrary(options: SoundLibraryOptions): SoundLibrary {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const prepared = new Map<string, PreparedSound | null>();
  const encoded = new Map<string, readonly Buffer[] | null>();
  const reasons = new Map<SoundName, string>();

  function key(sound: SoundName, volumePercent: number): string {
    return `${sound}:${volumePercent}`;
  }

  function load(sound: SoundName, volumePercent: number): PreparedSound | null {
    if (!Number.isFinite(volumePercent) || volumePercent <= 0) return null;

    const cacheKey = key(sound, volumePercent);
    const cached = prepared.get(cacheKey);
    if (cached !== undefined) return cached;

    let result: PreparedSound | null = null;
    try {
      const decoded = decodeWav(readFile(join(options.directory, `${sound}.wav`)));
      result = {
        samples: applyVolume(decoded.samples, volumePercent / 100),
        sampleRate: decoded.sampleRate,
      };
      reasons.delete(sound);
    } catch (error) {
      const reason = describe(error);
      reasons.set(sound, reason);
      // Log once per sound rather than once per attempt.
      options.logger.warn("cue sound unavailable; continuing without it", {
        sound,
        directory: options.directory,
        reason,
      });
      result = null;
    }

    prepared.set(cacheKey, result);
    return result;
  }

  return {
    samples(sound, volumePercent) {
      return load(sound, volumePercent)?.samples ?? null;
    },

    frames(sound, volumePercent) {
      const cacheKey = key(sound, volumePercent);
      const cached = encoded.get(cacheKey);
      if (cached !== undefined) return cached;

      let frames: readonly Buffer[] | null = null;
      const sound_ = load(sound, volumePercent);
      if (sound_) {
        try {
          frames = encodeToOpusFrames(sound_.samples, sound_.sampleRate || SAMPLE_RATE);
        } catch (error) {
          reasons.set(sound, describe(error));
          frames = null;
        }
      }

      encoded.set(cacheKey, frames);
      return frames;
    },

    preload() {
      const available: SoundName[] = [];
      const unavailable: { sound: SoundName; reason: string }[] = [];

      for (const sound of SOUND_NAMES) {
        const decoded = load(sound, 100);
        if (decoded && decoded.samples.length > 0) {
          available.push(sound);
        } else {
          unavailable.push({ sound, reason: reasons.get(sound) ?? "produced no audio samples" });
        }
      }

      return { available, unavailable };
    },
  };
}
