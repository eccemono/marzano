import { describe, expect, it } from "vitest";

import { SplitError, parseSplit } from "../src/domain/split";

describe("parseSplit", () => {
  it("derives breaks from a single focus value using the 5:1:3 ratio", () => {
    expect(parseSplit("25")).toEqual({
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
    });
  });

  it("doubles the short break for the long break when only two values are given", () => {
    expect(parseSplit("25 5")).toEqual({
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 10,
    });
  });

  it("accepts an explicit three-value split", () => {
    expect(parseSplit("25 5 15")).toEqual({
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
    });
  });

  it("accepts dash, comma and slash separators", () => {
    const expected = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15 };

    expect(parseSplit("25-5-15")).toEqual(expected);
    expect(parseSplit("25,5,15")).toEqual(expected);
    expect(parseSplit("25 / 5 / 15")).toEqual(expected);
  });

  it("ignores surrounding and repeated whitespace", () => {
    expect(parseSplit("   25    5    15   ")).toEqual({
      focusMinutes: 25,
      shortBreakMinutes: 5,
      longBreakMinutes: 15,
    });
  });

  it("scales the derived ratio for other focus lengths", () => {
    expect(parseSplit("50")).toEqual({
      focusMinutes: 50,
      shortBreakMinutes: 10,
      longBreakMinutes: 30,
    });
  });

  it("rejects empty input", () => {
    expect(() => parseSplit("")).toThrow(SplitError);
    expect(() => parseSplit("   ")).toThrow(SplitError);
  });

  it("rejects non-numeric input", () => {
    expect(() => parseSplit("abc")).toThrow(SplitError);
    expect(() => parseSplit("25 five 15")).toThrow(SplitError);
  });

  it("rejects zero", () => {
    expect(() => parseSplit("0")).toThrow(SplitError);
  });

  it("rejects negative values rather than dropping the sign", () => {
    expect(() => parseSplit("-25")).toThrow(/negative/i);
    expect(() => parseSplit("25 -5")).toThrow(/negative/i);
  });

  it("rejects fractional minutes", () => {
    expect(() => parseSplit("2.5")).toThrow(/whole minutes/i);
  });

  it("rejects more than three values", () => {
    expect(() => parseSplit("25 5 15 20")).toThrow(/at most three/i);
  });

  it("rejects values out of range", () => {
    expect(() => parseSplit("200 5 15")).toThrow(/focus period/i);
    expect(() => parseSplit("25 5 500")).toThrow(/long break/i);
  });

  it("rejects a break longer than the focus period as a likely ordering mistake", () => {
    expect(() => parseSplit("10 30 60")).toThrow(/cannot be longer than the focus period/i);
  });

  it("rejects a long break shorter than the short break", () => {
    expect(() => parseSplit("25 15 10")).toThrow(/cannot be shorter than the short break/i);
  });

  it("produces a message that is safe to show to a user", () => {
    try {
      parseSplit("nonsense");
      expect.unreachable("expected parseSplit to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitError);
      expect((error as Error).message).not.toMatch(/at Object|undefined|NaN/);
    }
  });
});
