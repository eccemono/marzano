/**
 * Raw PCM for Discord's audio pipeline.
 *
 * `StreamType.Raw` accepts signed 16-bit little-endian PCM at 48 kHz with
 * **two** channels. Feeding it mono is a silent failure rather than an error, so
 * mono sources are duplicated into both channels here.
 *
 * This is the path the cues actually play through. The alternative - encoding
 * to Opus ourselves and streaming `StreamType.Opus` - was measured draining a
 * two-second bell in about 125ms, because a pre-encoded packet stream gives the
 * player nothing to pace against. Handing over PCM lets the pipeline encode and
 * pace it, which takes the length of the audio.
 */

import { Readable } from "node:stream";

import { toPcm16 } from "./wav";

const BYTES_PER_SAMPLE = 2;
const CHANNELS = 2;

/** One stereo 16-bit frame, repeated, as a stream the player can consume. */
export function pcmStreamFromSamples(samples: Float64Array): Readable {
  const pcm = Buffer.alloc(samples.length * BYTES_PER_SAMPLE * CHANNELS);

  for (let index = 0; index < samples.length; index += 1) {
    const value = toPcm16(samples[index] ?? 0);
    const offset = index * BYTES_PER_SAMPLE * CHANNELS;
    pcm.writeInt16LE(value, offset);
    pcm.writeInt16LE(value, offset + BYTES_PER_SAMPLE);
  }

  const stream = new Readable({ read() {} });
  stream.push(pcm);
  stream.push(null);
  return stream;
}
