/**
 * The effective configuration for a session, and how it is resolved.
 *
 * Precedence, lowest first:
 *
 *   built-in defaults  ->  guild defaults  ->  voice-channel overrides
 *
 * Each layer only needs to specify what it changes, so a channel can override
 * the split without also restating the sound settings.
 */

import { type Split, SPLIT_LIMITS } from "./split";

export interface PomodoroConfig {
  focusMinutes: number;
  shortBreakMinutes: number;
  longBreakMinutes: number;
  /** Focus periods completed before a long break. */
  cyclesBeforeLongBreak: number;
  soundEnabled: boolean;
  /** 0-100. */
  soundVolume: number;
  /**
   * How a stage boundary is crossed.
   *
   * `auto` advances every boundary on its own. `manual` holds at every boundary
   * and waits for someone to press Continue. `semi` advances into a break by
   * itself but holds before the next focus period, so the break is automatic and
   * starting work is a deliberate act.
   */
  advanceMode: AdvanceMode;
}

/** The three ways a boundary can be handled. See `PomodoroConfig.advanceMode`. */
export const ADVANCE_MODES = ["auto", "manual", "semi"] as const;
export type AdvanceMode = (typeof ADVANCE_MODES)[number];

export function isAdvanceMode(value: unknown): value is AdvanceMode {
  return typeof value === "string" && (ADVANCE_MODES as readonly string[]).includes(value);
}

/**
 * Whether a boundary that lands on `nextStage` should hold instead of advancing.
 *
 * Exported because this single predicate *is* the behaviour difference between
 * the three modes, and it is worth testing directly rather than only through a
 * full `advance` run.
 */
export function holdsAtBoundary(mode: AdvanceMode, nextStage: string): boolean {
  if (mode === "manual") return true;
  // Semi-automatic: the break comes by itself, but starting work does not.
  return mode === "semi" && nextStage === "focus";
}

export const CONFIG_LIMITS = {
  minCyclesBeforeLongBreak: 1,
  maxCyclesBeforeLongBreak: 12,
  minVolume: 0,
  maxVolume: 100,
} as const;

export const BUILT_IN_DEFAULTS: PomodoroConfig = {
  focusMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  cyclesBeforeLongBreak: 4,
  soundEnabled: true,
  soundVolume: 80,
  advanceMode: "semi",
};

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

function assertMinuteRange(name: string, value: number, max: number): void {
  if (!Number.isInteger(value) || value < SPLIT_LIMITS.minMinutes || value > max) {
    throw new ConfigValidationError(
      `${name} must be a whole number between ${SPLIT_LIMITS.minMinutes} and ${max}; received ${value}.`,
    );
  }
}

/** Validate a fully resolved configuration, throwing on the first problem. */
export function validateConfig(config: PomodoroConfig): PomodoroConfig {
  assertMinuteRange("focusMinutes", config.focusMinutes, SPLIT_LIMITS.maxFocusMinutes);
  assertMinuteRange("shortBreakMinutes", config.shortBreakMinutes, SPLIT_LIMITS.maxBreakMinutes);
  assertMinuteRange("longBreakMinutes", config.longBreakMinutes, SPLIT_LIMITS.maxBreakMinutes);

  if (
    !Number.isInteger(config.cyclesBeforeLongBreak) ||
    config.cyclesBeforeLongBreak < CONFIG_LIMITS.minCyclesBeforeLongBreak ||
    config.cyclesBeforeLongBreak > CONFIG_LIMITS.maxCyclesBeforeLongBreak
  ) {
    throw new ConfigValidationError(
      `cyclesBeforeLongBreak must be between ${CONFIG_LIMITS.minCyclesBeforeLongBreak} and ${CONFIG_LIMITS.maxCyclesBeforeLongBreak}; received ${config.cyclesBeforeLongBreak}.`,
    );
  }

  if (
    !Number.isInteger(config.soundVolume) ||
    config.soundVolume < CONFIG_LIMITS.minVolume ||
    config.soundVolume > CONFIG_LIMITS.maxVolume
  ) {
    throw new ConfigValidationError(
      `soundVolume must be between ${CONFIG_LIMITS.minVolume} and ${CONFIG_LIMITS.maxVolume}; received ${config.soundVolume}.`,
    );
  }

  if (!isAdvanceMode(config.advanceMode)) {
    throw new ConfigValidationError(
      `advanceMode must be one of ${ADVANCE_MODES.join(", ")}; received ${String(config.advanceMode)}.`,
    );
  }

  if (config.shortBreakMinutes > config.focusMinutes) {
    throw new ConfigValidationError(
      `The short break (${config.shortBreakMinutes}m) cannot be longer than the focus period (${config.focusMinutes}m).`,
    );
  }

  if (config.longBreakMinutes < config.shortBreakMinutes) {
    throw new ConfigValidationError(
      `The long break (${config.longBreakMinutes}m) cannot be shorter than the short break (${config.shortBreakMinutes}m).`,
    );
  }

  return config;
}

export type PartialConfig = Partial<PomodoroConfig>;

/**
 * Resolve a configuration by layering partial configurations.
 *
 * Later layers win. `null` and `undefined` entries are skipped so a missing
 * guild default or channel override simply contributes nothing.
 */
export function resolveConfig(...layers: Array<PartialConfig | null | undefined>): PomodoroConfig {
  let merged: PomodoroConfig = { ...BUILT_IN_DEFAULTS };

  for (const layer of layers) {
    if (!layer) continue;
    // `??` skips undefined and null, so a layer that does not mention a field
    // leaves the value from the layer below it intact.
    merged = {
      focusMinutes: layer.focusMinutes ?? merged.focusMinutes,
      shortBreakMinutes: layer.shortBreakMinutes ?? merged.shortBreakMinutes,
      longBreakMinutes: layer.longBreakMinutes ?? merged.longBreakMinutes,
      cyclesBeforeLongBreak: layer.cyclesBeforeLongBreak ?? merged.cyclesBeforeLongBreak,
      soundEnabled: layer.soundEnabled ?? merged.soundEnabled,
      soundVolume: layer.soundVolume ?? merged.soundVolume,
      advanceMode: layer.advanceMode ?? merged.advanceMode,
    };
  }

  return validateConfig(merged);
}

/** Apply a parsed split on top of an existing configuration. */
export function applySplit(config: PomodoroConfig, split: Split): PomodoroConfig {
  return validateConfig({
    ...config,
    focusMinutes: split.focusMinutes,
    shortBreakMinutes: split.shortBreakMinutes,
    longBreakMinutes: split.longBreakMinutes,
  });
}
