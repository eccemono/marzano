import { describe, expect, it } from "vitest";

import {
  BUILT_IN_DEFAULTS,
  ConfigValidationError,
  applySplit,
  resolveConfig,
  validateConfig,
} from "../src/domain/config";

describe("resolveConfig", () => {
  it("returns the built-in defaults when no layer is supplied", () => {
    expect(resolveConfig()).toEqual(BUILT_IN_DEFAULTS);
  });

  it("skips null and undefined layers", () => {
    expect(resolveConfig(null, undefined, {})).toEqual(BUILT_IN_DEFAULTS);
  });

  it("lets a later layer win without disturbing untouched fields", () => {
    const resolved = resolveConfig({ focusMinutes: 50 });

    expect(resolved.focusMinutes).toBe(50);
    expect(resolved.shortBreakMinutes).toBe(BUILT_IN_DEFAULTS.shortBreakMinutes);
    expect(resolved.soundVolume).toBe(BUILT_IN_DEFAULTS.soundVolume);
  });

  it("applies built-in then guild then channel precedence", () => {
    const guild = { focusMinutes: 50, shortBreakMinutes: 10, longBreakMinutes: 20 };
    const channel = { soundEnabled: false, soundVolume: 25 };

    const resolved = resolveConfig(BUILT_IN_DEFAULTS, guild, channel);

    expect(resolved.focusMinutes).toBe(50);
    expect(resolved.longBreakMinutes).toBe(20);
    expect(resolved.soundEnabled).toBe(false);
    expect(resolved.soundVolume).toBe(25);
    expect(resolved.cyclesBeforeLongBreak).toBe(BUILT_IN_DEFAULTS.cyclesBeforeLongBreak);
  });

  it("rejects a layer combination that produces an invalid configuration", () => {
    expect(() => resolveConfig({ focusMinutes: 5, shortBreakMinutes: 10 })).toThrow(
      ConfigValidationError,
    );
  });
});

describe("validateConfig", () => {
  it("accepts the built-in defaults", () => {
    expect(validateConfig(BUILT_IN_DEFAULTS)).toEqual(BUILT_IN_DEFAULTS);
  });

  it("rejects out-of-range volumes and cycle counts", () => {
    expect(() => validateConfig({ ...BUILT_IN_DEFAULTS, soundVolume: 101 })).toThrow(/soundVolume/);
    expect(() => validateConfig({ ...BUILT_IN_DEFAULTS, cyclesBeforeLongBreak: 0 })).toThrow(
      /cyclesBeforeLongBreak/,
    );
  });

  it("rejects a break ordering that cannot be intended", () => {
    expect(() =>
      validateConfig({ ...BUILT_IN_DEFAULTS, focusMinutes: 5, shortBreakMinutes: 10 }),
    ).toThrow(/cannot be longer than the focus period/);

    expect(() =>
      validateConfig({ ...BUILT_IN_DEFAULTS, shortBreakMinutes: 20, longBreakMinutes: 10 }),
    ).toThrow(/cannot be shorter than the short break/);
  });
});

describe("applySplit", () => {
  it("replaces only the split fields", () => {
    const result = applySplit(BUILT_IN_DEFAULTS, {
      focusMinutes: 50,
      shortBreakMinutes: 10,
      longBreakMinutes: 20,
    });

    expect(result.focusMinutes).toBe(50);
    expect(result.longBreakMinutes).toBe(20);
    expect(result.cyclesBeforeLongBreak).toBe(BUILT_IN_DEFAULTS.cyclesBeforeLongBreak);
    expect(result.soundVolume).toBe(BUILT_IN_DEFAULTS.soundVolume);
  });
});
