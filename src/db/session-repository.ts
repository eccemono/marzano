import {
  SESSION_STAGES,
  SESSION_STATES,
  type SessionStage,
  type SessionState,
  type TimerSession,
} from "../domain/timer";

import type { Db } from "./database";

/**
 * Persistence for in-flight sessions.
 *
 * The table is keyed by guild because Discord permits a bot a single voice
 * connection per guild, and the plan requires a second start request to be
 * refused rather than silently overlapped.
 *
 * A session row stores concrete, fully-resolved settings rather than
 * references to the configuration layers: temporary in-session modifications
 * must survive a restart without ever touching the saved channel configuration.
 */

export { SESSION_STAGES, SESSION_STATES };
export type { SessionStage, SessionState };

/** The persisted shape is the engine's session shape. */
export type ActiveSessionRecord = TimerSession;

interface ActiveSessionRow {
  guild_id: string;
  voice_channel_id: string;
  text_channel_id: string | null;
  status_message_id: string | null;
  stage: string;
  state: string;
  stage_started_at: number | null;
  stage_ends_at: number | null;
  paused_remaining_ms: number | null;
  completed_focus_stages: number;
  focus_minutes: number;
  short_break_minutes: number;
  long_break_minutes: number;
  cycles_before_long_break: number;
  sound_enabled: number;
  sound_volume: number;
  auto_advance: number;
  awaiting_continue: number;
  stop_reason: string | null;
  updated_at: string;
}

function toStage(value: string): SessionStage {
  return (SESSION_STAGES as readonly string[]).includes(value) ? (value as SessionStage) : "focus";
}

function toState(value: string): SessionState {
  return (SESSION_STATES as readonly string[]).includes(value)
    ? (value as SessionState)
    : "stopped";
}

function rowToRecord(row: ActiveSessionRow): ActiveSessionRecord {
  return {
    guildId: row.guild_id,
    voiceChannelId: row.voice_channel_id,
    textChannelId: row.text_channel_id,
    statusMessageId: row.status_message_id,
    stage: toStage(row.stage),
    state: toState(row.state),
    stageStartedAt: row.stage_started_at,
    stageEndsAt: row.stage_ends_at,
    pausedRemainingMs: row.paused_remaining_ms,
    awaitingContinue: row.awaiting_continue === 1,
    completedFocusStages: row.completed_focus_stages,
    config: {
      focusMinutes: row.focus_minutes,
      shortBreakMinutes: row.short_break_minutes,
      longBreakMinutes: row.long_break_minutes,
      cyclesBeforeLongBreak: row.cycles_before_long_break,
      soundEnabled: row.sound_enabled === 1,
      soundVolume: row.sound_volume,
      autoAdvance: row.auto_advance === 1,
    },
    stopReason: row.stop_reason,
  };
}

export function getActiveSession(db: Db, guildId: string): ActiveSessionRecord | null {
  const row = db.prepare("SELECT * FROM active_sessions WHERE guild_id = ?").get(guildId) as
    | ActiveSessionRow
    | undefined;

  return row ? rowToRecord(row) : null;
}

/** Used on startup to reconcile sessions left behind by a restart. */
export function listActiveSessions(db: Db): ActiveSessionRecord[] {
  const rows = db
    .prepare("SELECT * FROM active_sessions ORDER BY updated_at ASC")
    .all() as ActiveSessionRow[];

  return rows.map(rowToRecord);
}

/** Upsert a session. The guild primary key guarantees one row per guild. */
export function saveActiveSession(db: Db, record: ActiveSessionRecord): void {
  db.prepare(
    `INSERT INTO active_sessions (
       guild_id, voice_channel_id, text_channel_id, status_message_id,
       stage, state, stage_started_at, stage_ends_at, paused_remaining_ms,
       completed_focus_stages, focus_minutes, short_break_minutes, long_break_minutes,
       cycles_before_long_break, sound_enabled, sound_volume, auto_advance,
       awaiting_continue, stop_reason, updated_at
     ) VALUES (
       @guild_id, @voice_channel_id, @text_channel_id, @status_message_id,
       @stage, @state, @stage_started_at, @stage_ends_at, @paused_remaining_ms,
       @completed_focus_stages, @focus_minutes, @short_break_minutes, @long_break_minutes,
       @cycles_before_long_break, @sound_enabled, @sound_volume, @auto_advance,
       @awaiting_continue, @stop_reason, @updated_at
     )
     ON CONFLICT (guild_id) DO UPDATE SET
       voice_channel_id         = excluded.voice_channel_id,
       text_channel_id          = excluded.text_channel_id,
       status_message_id        = excluded.status_message_id,
       stage                    = excluded.stage,
       state                    = excluded.state,
       stage_started_at         = excluded.stage_started_at,
       stage_ends_at            = excluded.stage_ends_at,
       paused_remaining_ms      = excluded.paused_remaining_ms,
       completed_focus_stages   = excluded.completed_focus_stages,
       focus_minutes            = excluded.focus_minutes,
       short_break_minutes      = excluded.short_break_minutes,
       long_break_minutes       = excluded.long_break_minutes,
       cycles_before_long_break = excluded.cycles_before_long_break,
       sound_enabled            = excluded.sound_enabled,
       sound_volume             = excluded.sound_volume,
       auto_advance             = excluded.auto_advance,
       awaiting_continue        = excluded.awaiting_continue,
       stop_reason              = excluded.stop_reason,
       updated_at               = excluded.updated_at`,
  ).run({
    guild_id: record.guildId,
    voice_channel_id: record.voiceChannelId,
    text_channel_id: record.textChannelId,
    status_message_id: record.statusMessageId,
    stage: record.stage,
    state: record.state,
    stage_started_at: record.stageStartedAt,
    stage_ends_at: record.stageEndsAt,
    paused_remaining_ms: record.pausedRemainingMs,
    awaiting_continue: record.awaitingContinue ? 1 : 0,
    completed_focus_stages: record.completedFocusStages,
    focus_minutes: record.config.focusMinutes,
    short_break_minutes: record.config.shortBreakMinutes,
    long_break_minutes: record.config.longBreakMinutes,
    cycles_before_long_break: record.config.cyclesBeforeLongBreak,
    sound_enabled: record.config.soundEnabled ? 1 : 0,
    sound_volume: record.config.soundVolume,
    auto_advance: record.config.autoAdvance ? 1 : 0,
    stop_reason: record.stopReason,
    updated_at: new Date().toISOString(),
  });
}

export function deleteActiveSession(db: Db, guildId: string): boolean {
  return db.prepare("DELETE FROM active_sessions WHERE guild_id = ?").run(guildId).changes > 0;
}
