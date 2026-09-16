/**
 * Deterministic synthesis of the Marzano cue sounds.
 *
 * The sounds are generated rather than shipped as media: there is no third
 * party audio to license, no binary blob of unknown provenance in the
 * repository, and the exact bytes can be asserted in a test by regenerating
 * them in memory.
 *
 * Everything here is pure arithmetic - summed sine partials with an
 * exponential decay envelope - so the same input always produces byte-identical
 * output. There is no randomness and no reliance on the platform's audio stack.
 */

import { SAMPLE_RATE } from "./wav";

interface Partial {
  frequency: number;
  amplitude: number;
  /** Exponential decay in nepers per second; larger fades faster. */
  decay: number;
  /** Seconds after the start of the sound. */
  start?: number;
  /** Seconds. */
  duration: number;
}

/** A very short fade-in, so the waveform does not start with a click. */
const ATTACK_SECONDS = 0.004;

const PEAK = 0.9;

function render(totalSeconds: number, partials: readonly Partial[]): Float64Array {
  const length = Math.max(1, Math.round(totalSeconds * SAMPLE_RATE));
  const output = new Float64Array(length);
  const attackSamples = Math.max(1, Math.round(ATTACK_SECONDS * SAMPLE_RATE));

  for (const partial of partials) {
    const startIndex = Math.round((partial.start ?? 0) * SAMPLE_RATE);
    const count = Math.round(partial.duration * SAMPLE_RATE);

    for (let offset = 0; offset < count; offset += 1) {
      const index = startIndex + offset;
      if (index >= length) break;

      const seconds = offset / SAMPLE_RATE;
      const attack = Math.min(1, offset / attackSamples);
      const envelope = attack * Math.exp(-partial.decay * seconds);

      output[index] =
        (output[index] ?? 0) +
        partial.amplitude * envelope * Math.sin(2 * Math.PI * partial.frequency * seconds);
    }
  }

  return scaleToPeak(output, PEAK);
}

/** Scale in place so the loudest sample sits exactly at `peak`. */
export function scaleToPeak(samples: Float64Array, peak: number): Float64Array {
  let loudest = 0;
  for (const sample of samples) {
    const magnitude = sample < 0 ? -sample : sample;
    if (magnitude > loudest) loudest = magnitude;
  }
  if (loudest === 0) return samples;

  const factor = peak / loudest;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (samples[index] ?? 0) * factor;
  }
  return samples;
}

/** Multiply every sample by `volume` (0-1), in place, for playback volume. */
export function applyVolume(samples: Float64Array, volume: number): Float64Array {
  const clamped = volume < 0 ? 0 : volume > 1 ? 1 : volume;
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = (samples[index] ?? 0) * clamped;
  }
  return samples;
}

/**
 * The bell that marks the start of every stage.
 *
 * A struck bell is inharmonic, so the upper partials are deliberately not
 * integer multiples of the fundamental. They also decay faster than the
 * fundamental, which is what gives the sound its strike-then-ring shape.
 */
export function renderBell(): Float64Array {
  return render(2.0, [
    { frequency: 523.25, amplitude: 1.0, decay: 1.8, duration: 2.0 }, // C5
    { frequency: 1046.5, amplitude: 0.45, decay: 2.6, duration: 1.6 }, // C6
    { frequency: 1567.98, amplitude: 0.22, decay: 3.4, duration: 1.2 }, // G6
    { frequency: 2093.0, amplitude: 0.1, decay: 4.5, duration: 0.9 }, // C7
  ]);
}

/**
 * The cue played once when a session starts, before the first bell.
 *
 * A rising two-note figure. Only ever played at session start: later stage
 * transitions are marked by the bell alone.
 */
export function renderStartCue(): Float64Array {
  return render(1.1, [
    { frequency: 587.33, amplitude: 0.8, decay: 3.0, start: 0, duration: 0.5 }, // D5
    { frequency: 880.0, amplitude: 0.9, decay: 2.2, start: 0.16, duration: 0.9 }, // A5
    { frequency: 1174.66, amplitude: 0.25, decay: 3.0, start: 0.16, duration: 0.7 }, // D6
  ]);
}
