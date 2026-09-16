import {
  deleteChannelConfig,
  getChannelConfig,
  getGuildDefaults,
  saveChannelConfig,
  saveGuildDefaults,
} from "../db/config-repository";
import type { Db } from "../db/database";
import {
  ConfigValidationError,
  type PartialConfig,
  type PomodoroConfig,
  resolveConfig,
} from "../domain/config";
import { parseSplit } from "../domain/split";

/**
 * Applying the configuration wizards.
 *
 * The Discord layer collects values into a plain object and calls in here, so
 * the merging, validation and persistence rules are testable against an
 * in-memory database with no interaction objects involved.
 *
 * Writes here only ever touch the *saved* configuration. A running session
 * keeps its own resolved settings, so a wizard change never disturbs a session
 * in progress.
 */

export class WizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WizardError";
  }
}

export interface WizardInput {
  split?: string | null;
  cycles?: number | null;
  sound?: boolean | null;
  volume?: number | null;
  /** Copy the saved configuration from this voice channel first. */
  copyFromChannelId?: string | null;
  /** Forget the saved configuration entirely. */
  reset?: boolean;
}

export interface WizardResult {
  action: "reset" | "updated";
  /** The resolved configuration after the change, or null after a reset. */
  config: PomodoroConfig | null;
  /** Field names that were actually changed. */
  changed: string[];
}

function hasAnyChange(input: WizardInput): boolean {
  return (
    input.split != null ||
    input.cycles != null ||
    input.sound != null ||
    input.volume != null ||
    input.copyFromChannelId != null
  );
}

/**
 * Resolve and validate, presenting domain validation problems as WizardError.
 *
 * Callers above this layer only need to understand one error type, and a
 * bounds violation reads the same to the user whether the split parser or the
 * configuration validator found it.
 */
function resolveOrThrow(...layers: Array<PartialConfig | null | undefined>): PomodoroConfig {
  try {
    return resolveConfig(...layers);
  } catch (error) {
    if (error instanceof ConfigValidationError) throw new WizardError(error.message);
    throw error;
  }
}

function applyValues(base: PartialConfig, input: WizardInput, changed: string[]): PartialConfig {
  const next: PartialConfig = { ...base };

  const splitText = (input.split ?? "").trim();
  if (splitText.length > 0) {
    const split = parseSplit(splitText);
    next.focusMinutes = split.focusMinutes;
    next.shortBreakMinutes = split.shortBreakMinutes;
    next.longBreakMinutes = split.longBreakMinutes;
    changed.push("split");
  }

  if (input.cycles != null) {
    next.cyclesBeforeLongBreak = input.cycles;
    changed.push("cycles");
  }
  if (input.sound != null) {
    next.soundEnabled = input.sound;
    changed.push("sound");
  }
  if (input.volume != null) {
    next.soundVolume = input.volume;
    changed.push("volume");
  }

  return next;
}

/**
 * Update one voice channel's saved configuration.
 *
 * `copyFrom` seeds the base from another channel, so the caller can copy and
 * then adjust in the same command.
 */
export function applyChannelWizard(
  db: Db,
  guildId: string,
  voiceChannelId: string,
  input: WizardInput,
  configuredBy: string | null = null,
): WizardResult {
  if (input.reset) {
    // Delete the row outright. Writing an empty row instead would leave the
    // channel looking configured, so `/pomodoro start` would not offer setup.
    const removed = deleteChannelConfig(db, guildId, voiceChannelId);
    return {
      action: "reset",
      config: null,
      changed: removed ? ["reset"] : [],
    };
  }

  if (!hasAnyChange(input)) {
    throw new WizardError("Choose at least one setting to change, or use reset.");
  }

  let base: PartialConfig = getChannelConfig(db, guildId, voiceChannelId)?.config ?? {};
  const changed: string[] = [];

  const copyFrom = (input.copyFromChannelId ?? "").trim();
  if (copyFrom.length > 0) {
    const source = getChannelConfig(db, guildId, copyFrom);
    if (!source) {
      throw new WizardError(`<#${copyFrom}> has no saved configuration to copy.`);
    }
    base = { ...source.config };
    changed.push("copy_from");
  }

  const updated = applyValues(base, input, changed);

  // Validate against the guild layer so a channel override cannot resolve to
  // something nonsensical that the guild defaults would otherwise allow.
  const resolved = resolveOrThrow(getGuildDefaults(db, guildId), updated);

  saveChannelConfig(db, guildId, voiceChannelId, updated, configuredBy);

  return { action: "updated", config: resolved, changed };
}

/** Update the guild-wide defaults used by newly configured channels. */
export function applyGuildDefaultsWizard(
  db: Db,
  guildId: string,
  input: WizardInput,
): WizardResult {
  if (!hasAnyChange(input)) {
    throw new WizardError("Choose at least one setting to change.");
  }
  if (input.copyFromChannelId != null || input.reset) {
    throw new WizardError("Copy and reset are only available for a specific channel.");
  }

  const base: PartialConfig = getGuildDefaults(db, guildId) ?? {};
  const changed: string[] = [];
  const updated = applyValues(base, input, changed);
  const resolved = resolveOrThrow(updated);

  saveGuildDefaults(db, guildId, updated);

  return { action: "updated", config: resolved, changed };
}
