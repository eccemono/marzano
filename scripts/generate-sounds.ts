/**
 * Regenerates the cue sounds committed under `assets/sounds`.
 *
 * Run with `npm run sounds`. The output is deterministic: the synthesis is pure
 * arithmetic, so regenerating always produces byte-identical files. A test
 * asserts exactly that, which is what keeps the committed assets honest.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { renderBell, renderStartCue } from "../src/voice/tones";
import { SAMPLE_RATE, encodeWav } from "../src/voice/wav";

const outputDirectory = join(__dirname, "..", "assets", "sounds");

const sounds = [
  { name: "start", samples: renderStartCue() },
  { name: "bell", samples: renderBell() },
];

mkdirSync(outputDirectory, { recursive: true });

for (const sound of sounds) {
  const file = join(outputDirectory, `${sound.name}.wav`);
  const wav = encodeWav(sound.samples, SAMPLE_RATE);
  writeFileSync(file, wav);

  const seconds = (sound.samples.length / SAMPLE_RATE).toFixed(2);
  console.log(`${file}  ${seconds}s  ${wav.length} bytes`);
}
