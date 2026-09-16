import { readFileSync } from "node:fs";
import { join } from "node:path";

import OpusScript from "opusscript";
import { describe, expect, it } from "vitest";

import { createLogger } from "../src/logger";
import { pcmStreamFromSamples } from "../src/voice/pcm";
import {
  BREAK_CUE,
  BREAK_END_CUE,
  JOIN_CUE,
  WORK_CUE,
  createSoundLibrary,
} from "../src/voice/sounds";
import { FRAME_SAMPLES, encodeToOpusFrames, resampleLinear } from "../src/voice/opus";
import { applyVolume, renderBell, renderStartCue, scaleToPeak } from "../src/voice/tones";
import { SAMPLE_RATE, WavError, decodeWav, encodeWav, fromPcm16, toPcm16 } from "../src/voice/wav";

const ASSETS = join(__dirname, "..", "assets", "sounds");

function silentLogger() {
  return createLogger({ level: "error", sink: () => {} });
}

describe("PCM conversion", () => {
  it("round-trips a sample within one quantisation step", () => {
    for (const value of [0, 0.5, -0.5, 0.999, -0.999, 0.123456]) {
      expect(fromPcm16(toPcm16(value))).toBeCloseTo(value, 4);
    }
  });

  it("clamps out-of-range input instead of wrapping", () => {
    expect(toPcm16(2)).toBe(32_767);
    expect(toPcm16(-2)).toBe(-32_768);
  });

  it("uses the wider scale on the negative side", () => {
    expect(toPcm16(-1)).toBe(-32_768);
    expect(toPcm16(1)).toBe(32_767);
  });
});

describe("WAV encoding", () => {
  const samples = Float64Array.from([0, 0.5, -0.5, 1, -1]);

  it("writes a RIFF/WAVE header a decoder can read back", () => {
    const wav = encodeWav(samples);

    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 12, 16)).toBe("fmt ");
    expect(wav.length).toBe(44 + samples.length * 2);
  });

  it("round-trips samples through encode and decode", () => {
    const decoded = decodeWav(encodeWav(samples));

    expect(decoded.sampleRate).toBe(SAMPLE_RATE);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(samples.length);

    for (let index = 0; index < samples.length; index += 1) {
      expect(decoded.samples[index]).toBeCloseTo(samples[index] ?? 0, 4);
    }
  });

  it("rejects a file that is not RIFF/WAVE", () => {
    expect(() => decodeWav(Buffer.from("this is not audio at all, not even close"))).toThrow(
      WavError,
    );
  });

  it("rejects a truncated file", () => {
    expect(() => decodeWav(Buffer.alloc(10))).toThrow(WavError);
  });

  it("reports a missing data chunk rather than returning silence", () => {
    const headerOnly = encodeWav(Float64Array.from([0.1])).subarray(0, 36);

    expect(() => decodeWav(Buffer.from(headerOnly))).toThrow(WavError);
  });
});

describe("tone synthesis", () => {
  it("is deterministic: the same call twice is byte-identical", () => {
    expect(encodeWav(renderBell()).equals(encodeWav(renderBell()))).toBe(true);
    expect(encodeWav(renderStartCue()).equals(encodeWav(renderStartCue()))).toBe(true);
  });

  it("normalises to the target peak", () => {
    const scaled = scaleToPeak(Float64Array.from([0.1, -0.2, 0.05]), 0.9);

    expect(Math.max(...Array.from(scaled, Math.abs))).toBeCloseTo(0.9, 10);
  });

  it("leaves digital silence alone instead of dividing by zero", () => {
    const silence = Float64Array.from([0, 0, 0]);

    expect(Array.from(scaleToPeak(silence, 0.9))).toEqual([0, 0, 0]);
  });

  it("starts and ends near silence so cues do not click", () => {
    const bell = renderBell();

    expect(Math.abs(bell[0] ?? 0)).toBeLessThan(0.01);
    expect(Math.abs(bell[bell.length - 1] ?? 0)).toBeLessThan(0.01);
  });

  it("has the expected durations", () => {
    expect(renderBell().length).toBe(2 * SAMPLE_RATE);
    expect(renderStartCue().length).toBe(Math.round(1.1 * SAMPLE_RATE));
  });

  it("applies volume without exceeding range", () => {
    const halved = applyVolume(Float64Array.from([0.5, -0.5]), 0.5);

    expect(halved[0]).toBeCloseTo(0.25, 10);
    expect(halved[1]).toBeCloseTo(-0.25, 10);
  });

  it("clamps a volume above one", () => {
    const unchanged = applyVolume(Float64Array.from([0.5]), 5);

    expect(unchanged[0]).toBeCloseTo(0.5, 10);
  });
});

describe("committed sound assets", () => {
  it("are byte-identical to what the generator produces", () => {
    // This is the property that keeps the committed files honest: they are not
    // opaque binaries, they are the reproducible output of checked-in code.
    expect(readFileSync(join(ASSETS, "bell.wav")).equals(encodeWav(renderBell()))).toBe(true);
    expect(readFileSync(join(ASSETS, "start.wav")).equals(encodeWav(renderStartCue()))).toBe(true);
  });

  it("are 48 kHz mono 16-bit PCM", () => {
    const decoded = decodeWav(readFileSync(join(ASSETS, "bell.wav")));

    expect(decoded.sampleRate).toBe(48_000);
    expect(decoded.channels).toBe(1);
  });
});

describe("Opus encoding", () => {
  it("produces one packet per 20 ms frame", () => {
    // 2.0 s / 20 ms = 100 frames.
    expect(encodeToOpusFrames(renderBell(), SAMPLE_RATE).length).toBe(100);
    // 1.1 s / 20 ms = 55 frames.
    expect(encodeToOpusFrames(renderStartCue(), SAMPLE_RATE).length).toBe(55);
  });

  it("zero-pads a trailing partial frame rather than emitting a short one", () => {
    const short = Float64Array.from({ length: FRAME_SAMPLES + 10 }, () => 0.1);

    expect(encodeToOpusFrames(short, SAMPLE_RATE).length).toBe(2);
  });

  it("produces packets a decoder could read, not empty buffers", () => {
    const frames = encodeToOpusFrames(renderStartCue(), SAMPLE_RATE);

    for (const frame of frames) {
      expect(frame.length).toBeGreaterThan(0);
    }
  });

  it("resamples rather than failing when the rate is not 48 kHz", () => {
    const input = Float64Array.from({ length: 24_000 }, (_, index) => Math.sin(index / 50));
    const resampled = resampleLinear(input, 24_000, 48_000);

    expect(resampled.length).toBe(48_000);
  });

  it("treats an already-correct rate as a no-op", () => {
    const input = Float64Array.from([0.1, 0.2, 0.3]);

    expect(resampleLinear(input, SAMPLE_RATE, SAMPLE_RATE)).toBe(input);
  });

  it("survives a decode round trip at the right level", () => {
    // Locks in the opusscript calling convention: a Buffer plus an explicit
    // frame size. Getting the buffer shape wrong does not error - it silently
    // produces loud noise - so this asserts the audio actually comes back.
    const input = renderStartCue();
    const frames = encodeToOpusFrames(input, SAMPLE_RATE);

    const decoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.AUDIO);
    try {
      const decoded: number[] = [];
      for (const frame of frames) {
        const pcm = decoder.decode(frame);
        for (let offset = 0; offset + 1 < pcm.length; offset += 2) {
          decoded.push(pcm.readInt16LE(offset) / 32_768);
        }
      }

      let inputPeak = 0;
      for (const sample of input) inputPeak = Math.max(inputPeak, Math.abs(sample));

      let decodedPeak = 0;
      for (const sample of decoded) decodedPeak = Math.max(decodedPeak, Math.abs(sample));

      // Opus is lossy, so allow slack - but the cue must still be recognisably
      // present and must not have saturated into noise.
      expect(decodedPeak).toBeGreaterThan(inputPeak * 0.6);
      expect(decodedPeak).toBeLessThanOrEqual(1);
    } finally {
      decoder.delete();
    }
  });
});

describe("raw PCM for the audio pipeline", () => {
  it("duplicates mono samples into both channels as 16-bit PCM", async () => {
    // StreamType.Raw is stereo 16-bit at 48kHz, and feeding it mono fails
    // silently rather than erroring.
    const samples = Float64Array.from([0, 0.5, -0.5]);
    const stream = pcmStreamFromSamples(samples);

    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const pcm = Buffer.concat(chunks);

    // Three samples, two channels, two bytes each.
    expect(pcm.length).toBe(12);

    for (let index = 0; index < samples.length; index += 1) {
      expect(pcm.readInt16LE(index * 4)).toBe(pcm.readInt16LE(index * 4 + 2));
    }

    expect(pcm.readInt16LE(0)).toBe(0);
    expect(pcm.readInt16LE(4)).toBeGreaterThan(0);
    expect(pcm.readInt16LE(8)).toBeLessThan(0);
  });
});

describe("sound library", () => {
  it("preloads every committed cue", () => {
    const report = createSoundLibrary({ directory: ASSETS, logger: silentLogger() }).preload();

    expect(report.available).toEqual([JOIN_CUE, WORK_CUE, BREAK_CUE, BREAK_END_CUE]);
    expect(report.unavailable).toEqual([]);
  });

  it("returns frames for a known sound", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });
    const frames = sounds.frames(WORK_CUE, 80);

    expect(frames).not.toBeNull();
    expect(frames?.length).toBeGreaterThan(0);
  });

  it("returns decoded samples for a known sound", () => {
    // Cue playback streams these, so they have to exist for every cue that
    // preloads successfully.
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });
    const samples = sounds.samples(WORK_CUE, 80);

    expect(samples).not.toBeNull();
    // The cues are curated assets, so only their shape is asserted here.
    expect(samples?.length).toBeGreaterThan(0);
  });

  it("applies volume to the samples", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });
    const loud = sounds.samples(WORK_CUE, 100);
    const quiet = sounds.samples(WORK_CUE, 25);

    const peak = (data: Float64Array): number =>
      data.reduce((max, v) => Math.max(max, Math.abs(v)), 0);

    expect(peak(loud as Float64Array)).toBeGreaterThan(peak(quiet as Float64Array));
  });

  it("returns no samples at zero volume", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });

    expect(sounds.samples(WORK_CUE, 0)).toBeNull();
  });

  it("returns null at zero volume rather than playing silence", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });

    expect(sounds.frames(WORK_CUE, 0)).toBeNull();
  });

  it("degrades to null when an asset is missing, without throwing", () => {
    const sounds = createSoundLibrary({
      directory: "/nonexistent",
      logger: silentLogger(),
    });

    expect(sounds.frames(WORK_CUE, 50)).toBeNull();
    expect(sounds.preload().unavailable.map((entry) => entry.sound)).toEqual([
      JOIN_CUE,
      WORK_CUE,
      BREAK_CUE,
      BREAK_END_CUE,
    ]);
  });

  it("degrades to null when the asset is corrupt, without throwing", () => {
    const sounds = createSoundLibrary({
      directory: ASSETS,
      logger: silentLogger(),
      readFile: () => Buffer.from("corrupt"),
    });

    expect(sounds.frames(WORK_CUE, 50)).toBeNull();
  });

  it("caches per volume, so a second lookup is the same object", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });

    expect(sounds.frames(WORK_CUE, 70)).toBe(sounds.frames(WORK_CUE, 70));
  });

  it("encodes a quieter variant separately from a louder one", () => {
    const sounds = createSoundLibrary({ directory: ASSETS, logger: silentLogger() });
    const quiet = sounds.frames(WORK_CUE, 20);
    const loud = sounds.frames(WORK_CUE, 100);

    expect(quiet).not.toBeNull();
    expect(loud).not.toBeNull();
    expect(quiet).not.toBe(loud);
  });
});
