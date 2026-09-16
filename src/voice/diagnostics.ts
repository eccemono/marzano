/**
 * TEMPORARY diagnostic helpers for the sound investigation.
 *
 * Nothing here is part of the product: it exists so `/test` can play a cue
 * through several distinct audio paths and report what actually happened, and
 * it is deleted once the working path is known and folded into `voice/`.
 *
 * The reason it can be this blunt is that the only question is which layer
 * fails. Assets and the pure-JS Opus encoder have both been verified offline
 * (the generated WAVs are not silent, and opusscript's packets decode cleanly),
 * so the fault is in playback or in the voice connection carrying it.
 */

import { Readable } from "node:stream";

import { OpusEncoder } from "@discordjs/opus";

import { renderBell } from "./tones";
import { SAMPLE_RATE, toPcm16 } from "./wav";
import { encodeToOpusFrames } from "./opus";

export const PLAYBACK_STRATEGIES = ["current", "native", "pcm"] as const;
export type PlaybackStrategy = (typeof PLAYBACK_STRATEGIES)[number];

export const TEST_STRATEGIES = ["diag", ...PLAYBACK_STRATEGIES] as const;
export type TestStrategy = (typeof TEST_STRATEGIES)[number];

export const STRATEGY_HELP: Record<TestStrategy, string> = {
  diag: "Report the connection and permissions, then time a real playback",
  current: "The shipped path: opusscript packets streamed as StreamType.Opus",
  native: "The same stream, but encoded with @discordjs/opus instead",
  pcm: "Raw PCM handed to the audio pipeline, which encodes it itself",
};

/**
 * One 20 ms Opus packet is 960 samples at 48 kHz.
 *
 * `opusscript` needs the frame size passed explicitly; `@discordjs/opus` infers
 * it from the buffer length.
 */
const FRAME_SAMPLES = SAMPLE_RATE / 50;

/** A plain sine tone, so a successful test cannot be confused with a cue asset. */
export function renderSineTone(seconds = 2, frequency = 440): Float64Array {
  const length = Math.round(seconds * SAMPLE_RATE);
  const samples = new Float64Array(length);

  for (let index = 0; index < length; index += 1) {
    // A short fade in and out, so a working tone cannot be mistaken for a click
    // and a silent one cannot hide behind one.
    const position = index / length;
    const envelope = Math.min(1, position * 50, (1 - position) * 50);
    samples[index] = 0.9 * envelope * Math.sin((2 * Math.PI * frequency * index) / SAMPLE_RATE);
  }

  return samples;
}

/** The bell, rendered fresh rather than read from disk. */
export function renderTestBell(): Float64Array {
  return renderBell();
}

/** Encode with the native N-API Opus encoder. */
export function encodeNativeFrames(samples: Float64Array): Buffer[] {
  const encoder = new OpusEncoder(SAMPLE_RATE, 1);
  const frames: Buffer[] = [];
  const pcm = Buffer.alloc(FRAME_SAMPLES * 2);

  for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
    for (let index = 0; index < FRAME_SAMPLES; index += 1) {
      pcm.writeInt16LE(toPcm16(samples[offset + index] ?? 0), index * 2);
    }
    frames.push(encoder.encode(pcm));
  }

  return frames;
}

/** Encode with the pure-JS encoder the bot ships with. */
export function encodePortableFrames(samples: Float64Array): Buffer[] {
  return encodeToOpusFrames(samples, SAMPLE_RATE);
}

/**
 * Interleaved stereo 16-bit PCM, which is the only shape the raw path accepts.
 *
 * Mono input is duplicated into both channels: Discord's raw format is always
 * stereo, and feeding it mono is a silent failure rather than an error.
 */
export function pcmStreamFromSamples(samples: Float64Array): Readable {
  const frames = samples.length;
  const pcm = Buffer.alloc(frames * 4);

  for (let index = 0; index < frames; index += 1) {
    const value = toPcm16(samples[index] ?? 0);
    pcm.writeInt16LE(value, index * 4);
    pcm.writeInt16LE(value, index * 4 + 2);
  }

  const stream = new Readable({ read() {} });
  stream.push(pcm);
  stream.push(null);
  return stream;
}

/** A stream of one Opus packet per chunk. */
export function opusStreamFromFrames(frames: readonly Buffer[]): Readable {
  const stream = new Readable({ read() {} });
  for (const frame of frames) stream.push(Buffer.from(frame));
  stream.push(null);
  return stream;
}

export function sumBytes(frames: readonly Buffer[]): number {
  return frames.reduce((total, frame) => total + frame.length, 0);
}
