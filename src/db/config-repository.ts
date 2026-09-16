import { type PartialConfig, isAdvanceMode } from "../domain/config";

import type { Db } from "./database";

/**
 * Persistence for the two configuration layers.
 *
 * Columns are nullable on purpose: a guild default or channel override only
 * stores what it actually changes, and the resolver fills the rest from the
 * layer below. `null` therefore means "not set here", not "zero".
 */

interface ConfigColumns {
  focus_minutes: number | null;
  short_break_minutes: number | null;
  long_break_minutes: number | null;
  cycles_before_long_break: number | null;
  sound_enabled: number | null;
  sound_volume: number | null;
  advance_mode: string | null;
}

interface GuildDefaultsRow extends ConfigColumns {
  updated_at: string;
}

interface ChannelConfigRow extends ConfigColumns {
  configured_by: string | null;
  updated_at: string;
}

export interface ChannelConfig {
  voiceChannelId: string;
  config: PartialConfig;
  configuredBy: string | null;
  updatedAt: string;
}

export interface ChannelConfigSummary {
  voiceChannelId: string;
  updatedAt: string;
}

function rowToPartial(row: ConfigColumns): PartialConfig {
  const partial: PartialConfig = {};

  if (row.focus_minutes !== null) partial.focusMinutes = row.focus_minutes;
  if (row.short_break_minutes !== null) partial.shortBreakMinutes = row.short_break_minutes;
  if (row.long_break_minutes !== null) partial.longBreakMinutes = row.long_break_minutes;
  if (row.cycles_before_long_break !== null) {
    partial.cyclesBeforeLongBreak = row.cycles_before_long_break;
  }
  if (row.sound_enabled !== null) partial.soundEnabled = row.sound_enabled === 1;
  if (row.sound_volume !== null) partial.soundVolume = row.sound_volume;
  // An unrecognised stored value is treated as "not set here" rather than
  // guessed at, so a bad row falls through to the layer below.
  if (isAdvanceMode(row.advance_mode)) partial.advanceMode = row.advance_mode;

  return partial;
}

function partialToColumns(partial: PartialConfig): ConfigColumns {
  return {
    focus_minutes: partial.focusMinutes ?? null,
    short_break_minutes: partial.shortBreakMinutes ?? null,
    long_break_minutes: partial.longBreakMinutes ?? null,
    cycles_before_long_break: partial.cyclesBeforeLongBreak ?? null,
    sound_enabled: partial.soundEnabled === undefined ? null : partial.soundEnabled ? 1 : 0,
    sound_volume: partial.soundVolume ?? null,
    advance_mode: partial.advanceMode ?? null,
  };
}

export function getGuildDefaults(db: Db, guildId: string): PartialConfig | null {
  const row = db
    .prepare(
      `SELECT focus_minutes, short_break_minutes, long_break_minutes,
              cycles_before_long_break, sound_enabled, sound_volume, advance_mode, updated_at
         FROM guild_defaults
        WHERE guild_id = ?`,
    )
    .get(guildId) as GuildDefaultsRow | undefined;

  return row ? rowToPartial(row) : null;
}

/** Replace the guild layer wholesale; unspecified fields become "not set". */
export function saveGuildDefaults(db: Db, guildId: string, partial: PartialConfig): void {
  const columns = partialToColumns(partial);

  db.prepare(
    `INSERT INTO guild_defaults (
       guild_id, focus_minutes, short_break_minutes, long_break_minutes,
       cycles_before_long_break, sound_enabled, sound_volume, advance_mode, updated_at
     ) VALUES (
       @guild_id, @focus_minutes, @short_break_minutes, @long_break_minutes,
       @cycles_before_long_break, @sound_enabled, @sound_volume, @advance_mode, @updated_at
     )
     ON CONFLICT (guild_id) DO UPDATE SET
       focus_minutes            = excluded.focus_minutes,
       short_break_minutes      = excluded.short_break_minutes,
       long_break_minutes       = excluded.long_break_minutes,
       cycles_before_long_break = excluded.cycles_before_long_break,
       sound_enabled            = excluded.sound_enabled,
       sound_volume             = excluded.sound_volume,
       advance_mode             = excluded.advance_mode,
       updated_at               = excluded.updated_at`,
  ).run({
    guild_id: guildId,
    ...columns,
    updated_at: new Date().toISOString(),
  });
}

export function deleteGuildDefaults(db: Db, guildId: string): boolean {
  return db.prepare("DELETE FROM guild_defaults WHERE guild_id = ?").run(guildId).changes > 0;
}

export function getChannelConfig(
  db: Db,
  guildId: string,
  voiceChannelId: string,
): ChannelConfig | null {
  const row = db
    .prepare(
      `SELECT focus_minutes, short_break_minutes, long_break_minutes,
              cycles_before_long_break, sound_enabled, sound_volume, advance_mode,
              configured_by, updated_at
         FROM channel_configs
        WHERE guild_id = ? AND voice_channel_id = ?`,
    )
    .get(guildId, voiceChannelId) as ChannelConfigRow | undefined;

  if (!row) return null;

  return {
    voiceChannelId,
    config: rowToPartial(row),
    configuredBy: row.configured_by,
    updatedAt: row.updated_at,
  };
}

/** Replace a channel's override layer wholesale. */
export function saveChannelConfig(
  db: Db,
  guildId: string,
  voiceChannelId: string,
  partial: PartialConfig,
  configuredBy: string | null = null,
): void {
  const columns = partialToColumns(partial);

  db.prepare(
    `INSERT INTO channel_configs (
       guild_id, voice_channel_id, focus_minutes, short_break_minutes, long_break_minutes,
       cycles_before_long_break, sound_enabled, sound_volume, advance_mode, configured_by, updated_at
     ) VALUES (
       @guild_id, @voice_channel_id, @focus_minutes, @short_break_minutes, @long_break_minutes,
       @cycles_before_long_break, @sound_enabled, @sound_volume, @advance_mode, @configured_by, @updated_at
     )
     ON CONFLICT (guild_id, voice_channel_id) DO UPDATE SET
       focus_minutes            = excluded.focus_minutes,
       short_break_minutes      = excluded.short_break_minutes,
       long_break_minutes       = excluded.long_break_minutes,
       cycles_before_long_break = excluded.cycles_before_long_break,
       sound_enabled            = excluded.sound_enabled,
       sound_volume             = excluded.sound_volume,
       advance_mode             = excluded.advance_mode,
       configured_by            = excluded.configured_by,
       updated_at               = excluded.updated_at`,
  ).run({
    guild_id: guildId,
    voice_channel_id: voiceChannelId,
    ...columns,
    configured_by: configuredBy,
    updated_at: new Date().toISOString(),
  });
}

export function deleteChannelConfig(db: Db, guildId: string, voiceChannelId: string): boolean {
  return (
    db
      .prepare("DELETE FROM channel_configs WHERE guild_id = ? AND voice_channel_id = ?")
      .run(guildId, voiceChannelId).changes > 0
  );
}

/** Every configured channel in a guild, for the copy-from autocomplete. */
export function listChannelConfigs(db: Db, guildId: string): ChannelConfigSummary[] {
  const rows = db
    .prepare(
      `SELECT voice_channel_id, updated_at
         FROM channel_configs
        WHERE guild_id = ?
        ORDER BY updated_at DESC`,
    )
    .all(guildId) as Array<{ voice_channel_id: string; updated_at: string }>;

  return rows.map((row) => ({
    voiceChannelId: row.voice_channel_id,
    updatedAt: row.updated_at,
  }));
}
