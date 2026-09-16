/**
 * Minimal RIFF/WAVE reading and writing.
 *
 * Marzano generates its own cue sounds rather than shipping third-party media,
 * so it needs just enough WAV handling to write those files out and read them
 * back. Only uncompressed 16-bit PCM is supported, which is all the generator
 * produces.
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 1;
export const BITS_PER_SAMPLE = 16;

const HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;

export class WavError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WavError";
  }
}

/** Convert a normalised float sample to signed 16-bit PCM. */
export function toPcm16(sample: number): number {
  const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
  // The negative range is one step wider than the positive range, so use the
  // matching scale on each side to avoid clipping a full-scale negative peak.
  return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
}

/** Convert signed 16-bit PCM back to a normalised float sample. */
export function fromPcm16(value: number): number {
  return value / 32_768;
}

export function encodeWav(samples: Float64Array, sampleRate: number = SAMPLE_RATE): Buffer {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // format 1 = uncompressed PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * CHANNELS * BYTES_PER_SAMPLE, 28); // byte rate
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataBytes, 40);

  for (let index = 0; index < samples.length; index += 1) {
    buffer.writeInt16LE(toPcm16(samples[index] ?? 0), HEADER_BYTES + index * BYTES_PER_SAMPLE);
  }

  return buffer;
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  /** Mono, downmixed from however many channels the file carries. */
  samples: Float64Array;
}

export function decodeWav(buffer: Buffer): DecodedWav {
  if (
    buffer.length < HEADER_BYTES ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new WavError("not a RIFF/WAVE file");
  }

  let format: { channels: number; sampleRate: number; bitsPerSample: number; code: number } | null =
    null;
  let data: Buffer | null = null;

  // Walk the chunk list rather than assuming a 44-byte header: some encoders
  // insert LIST/fact chunks before the data.
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt ") {
      format = {
        code: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }

    // Chunks are word-aligned, so an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
  }

  if (!format) throw new WavError("missing fmt chunk");
  if (!data) throw new WavError("missing data chunk");
  if (format.code !== 1) {
    throw new WavError(
      `unsupported WAV format code ${format.code}; only uncompressed PCM is supported`,
    );
  }
  if (format.bitsPerSample !== BITS_PER_SAMPLE) {
    throw new WavError(
      `unsupported bit depth ${format.bitsPerSample}; only ${BITS_PER_SAMPLE}-bit is supported`,
    );
  }
  if (format.channels < 1) throw new WavError("WAV file declares no channels");

  const frameBytes = format.channels * BYTES_PER_SAMPLE;
  const frames = Math.floor(data.length / frameBytes);
  const samples = new Float64Array(frames);

  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < format.channels; channel += 1) {
      sum += fromPcm16(data.readInt16LE(frame * frameBytes + channel * BYTES_PER_SAMPLE));
    }
    samples[frame] = sum / format.channels;
  }

  return { sampleRate: format.sampleRate, channels: format.channels, samples };
}
