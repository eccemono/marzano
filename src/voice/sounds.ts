/**
 * The cue sounds, decoded and pre-encoded once per (sound, volume) pair.
 *
 * Encoding is lazy and cached because it is the expensive part, and volume is
 * part of the cache key because volume is applied to the samples before
 * encoding rather than to the output packets.
 *
 * No failure in here is ever allowed to throw at the caller: a missing asset, an
 * unusable Opus encoder or a corrupt file degrades to silence, and the session
 * carries on. Sound is a nicety, not the product.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Logger } from "../logger";

import { encodeToOpusFrames } from "./opus";
import { applyVolume } from "./tones";
import { decodeWav } from "./wav";

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
   * Opus frames for a sound at the given volume (0-100).
   *
   * Returns `null` when the sound should not be played - either because the
   * volume is zero or because the sound could not be prepared.
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSoundLibrary(options: SoundLibraryOptions): SoundLibrary {
  const readFile = options.readFile ?? ((path: string) => readFileSync(path));
  const cache = new Map<string, readonly Buffer[] | null>();
  const reasons = new Map<SoundName, string>();

  function load(sound: SoundName, volumePercent: number): readonly Buffer[] | null {
    if (!Number.isFinite(volumePercent) || volumePercent <= 0) return null;

    const key = `${sound}:${volumePercent}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    let frames: readonly Buffer[] | null = null;
    try {
      const decoded = decodeWav(readFile(join(options.directory, `${sound}.wav`)));
      const samples = applyVolume(decoded.samples, volumePercent / 100);
      frames = encodeToOpusFrames(samples, decoded.sampleRate);
      reasons.delete(sound);
    } catch (error) {
      const reason = describe(error);
      reasons.set(sound, reason);
      // Log once per sound rather than once per attempt.
      if (!cache.has(`${sound}:${volumePercent}`)) {
        options.logger.warn("cue sound unavailable; continuing without it", {
          sound,
          directory: options.directory,
          reason,
        });
      }
      frames = null;
    }

    cache.set(key, frames);
    return frames;
  }

  return {
    frames(sound, volumePercent) {
      return load(sound, volumePercent);
    },

    preload() {
      const available: SoundName[] = [];
      const unavailable: { sound: SoundName; reason: string }[] = [];

      for (const sound of SOUND_NAMES) {
        const frames = load(sound, 100);
        if (frames && frames.length > 0) {
          available.push(sound);
        } else {
          unavailable.push({ sound, reason: reasons.get(sound) ?? "produced no audio frames" });
        }
      }

      return { available, unavailable };
    },
  };
}
