import { describe, expect, it } from "vitest";

import {
  TOMATO_FACTS,
  TOMATO_FACT_COUNT,
  factForBreak,
  mulberry32,
  newFactSeed,
  seededShuffle,
} from "../src/domain/facts";

/**
 * The facts are data, but the rules around them - deterministic shuffle, one
 * fact per break, no repeats inside a session - are behaviour, and that is what
 * these cover.
 */
describe("the fact list", () => {
  it("has facts to show", () => {
    expect(TOMATO_FACT_COUNT).toBeGreaterThan(100);
    expect(TOMATO_FACT_COUNT).toBe(TOMATO_FACTS.length);
  });

  it("keeps every fact to a single line", () => {
    for (const fact of TOMATO_FACTS) {
      expect(fact).not.toContain("\n");
      expect(fact.trim()).toBe(fact);
      expect(fact.length).toBeGreaterThan(0);
    }
  });

  it("does not restate the same fact twice", () => {
    // The list is the product: two entries saying the same thing in different
    // words would show up as a repeat the shuffle cannot avoid.
    const normalised = TOMATO_FACTS.map((fact) =>
      fact
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );

    expect(new Set(normalised).size).toBe(normalised.length);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a seed", () => {
    const first = mulberry32(7);
    const second = mulberry32(7);

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it("stays inside [0, 1)", () => {
    const random = mulberry32(123);

    for (let index = 0; index < 200; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("seededShuffle", () => {
  it("never mutates its input", () => {
    const input = ["a", "b", "c", "d"];
    seededShuffle(input, 1);

    expect(input).toEqual(["a", "b", "c", "d"]);
  });

  it("returns the same order for the same seed", () => {
    expect(seededShuffle(TOMATO_FACTS, 99)).toEqual(seededShuffle(TOMATO_FACTS, 99));
  });

  it("returns a different order for a different seed", () => {
    // This is what makes two sessions feel different rather than replaying the
    // same playlist.
    expect(seededShuffle(TOMATO_FACTS, 1)).not.toEqual(seededShuffle(TOMATO_FACTS, 2));
  });

  it("keeps every item", () => {
    expect([...seededShuffle(TOMATO_FACTS, 5)].sort()).toEqual([...TOMATO_FACTS].sort());
  });
});

describe("factForBreak", () => {
  it("gives every break of a session its own fact", () => {
    const seed = 4242;
    const shown = Array.from({ length: 40 }, (_, index) => factForBreak(seed, index + 1));

    expect(new Set(shown).size).toBe(shown.length);
  });

  it("is stable, so a refresh does not change the fact mid-break", () => {
    expect(factForBreak(11, 3)).toBe(factForBreak(11, 3));
  });

  it("gives two sessions with different seeds different playlists", () => {
    const first = Array.from({ length: 10 }, (_, index) => factForBreak(1, index + 1));
    const second = Array.from({ length: 10 }, (_, index) => factForBreak(2, index + 1));

    expect(first).not.toEqual(second);
  });

  it("reshuffles instead of repeating once the list is exhausted", () => {
    const seed = 8;
    const cycleLength = TOMATO_FACT_COUNT;

    const lastOfFirstCycle = factForBreak(seed, cycleLength);
    const firstOfSecondCycle = factForBreak(seed, cycleLength + 1);

    expect(firstOfSecondCycle).not.toBe(lastOfFirstCycle);
  });

  it("still answers before the first break has happened", () => {
    expect(TOMATO_FACTS).toContain(factForBreak(3, 0));
  });
});

describe("newFactSeed", () => {
  it("produces a non-negative integer", () => {
    for (let index = 0; index < 50; index += 1) {
      const seed = newFactSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
    }
  });
});
