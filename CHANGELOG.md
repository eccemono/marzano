# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- PM2 process configuration, deploy script and health heartbeat. _(pending)_

## [0.1.0] - 2026-09-16

First release. A working Discord Pomodoro bot for shared voice-channel sessions.

### Added

**Foundation**

- Strict TypeScript on Node 22, with the major version asserted at startup.
  Node 24 aborts inside native SQLite bindings
  ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)), so the bot
  refuses to run on it rather than crashing unpredictably later.
- Structured JSON logging with mandatory secret redaction on every value.
- Configuration loading from the environment, validated at boot.
- CI running format, lint, typecheck, build and tests; CodeQL analysis;
  dependency review; Dependabot.
- MIT licence, contributing guide, code of conduct, security policy.

**Domain**

- Flexible split parsing: `25`, `25 5`, `25 5 15` and `25-5-15` all work.
- Layered configuration: built-in defaults, server defaults, per-channel
  settings and in-session changes, each overriding only the fields it mentions.
- SQLite persistence in WAL mode, with versioned migrations.

**Timer**

- Timestamp-based state machine: remaining time is derived from deadlines, so a
  missed tick shows a stale number rather than a wrong one.
- Pause, resume, skip and extend, plus restart maths that keeps the schedule on
  its original lattice.
- Per-guild serialization, so two interactions arriving together cannot lose
  each other's writes.

**Commands**

- `/pomodoro start|status|configure|default|stop` and `/info`.
- Native voice-channel pickers for channel-scoped configuration, because
  Discord's autocomplete is capped at 25 choices and server channel lists
  routinely exceed that.
- Permission enforcement: channel settings need Manage Channels, server
  defaults need Manage Guild.

**Session UI**

- A single canonical status embed per session, refreshed every 15 seconds,
  showing stage, split, cycle position, elapsed and remaining time.
- Buttons for pause/resume, skip, stop and modify, with confirmation before
  anything that discards work in progress.
- Authorization re-checked on every press against the caller's current voice
  state; a visible button is never treated as permission.
- A deleted status message is detected and replaced rather than killing the
  session; transient failures back off exponentially and recover.

**Voice**

- Voice connection, cue playback and clean departure.
- Cue sounds generated deterministically by a checked-in script, with no
  third-party media. Regenerating is byte-identical, and a test asserts the
  committed files match what the generator produces.
- **No FFmpeg.** Sounds are pre-encoded to Opus in-process and sent directly, so
  the audio path has no external binary in it.
- Muted and deafened while silent, unmuting only for the length of a cue.
- A missing asset, an unusable encoder, a deleted channel, a dropped connection
  or a revoked permission all degrade to silence rather than ending a session.

**Lifecycle**

- One session per guild, with a second start pointing at the channel that holds
  the first. Sessions in different servers run independently.
- Restart recovery: missed boundaries are replayed so the schedule is correct,
  but their bells are not replayed, and the count is logged.
- Paused sessions return with their exact remaining duration.
- Unrecoverable sessions - deleted channel, nobody present - stop with a
  recorded reason.
- A 60 second grace period when the last participant leaves, cancelled by
  anyone returning.
- Graceful shutdown on SIGINT and SIGTERM within a bounded timeout.

**Documentation**

- `docs/OPERATIONS.md`: PM2 commands, backup and restore, rollback, recovery.
- `docs/BRANDING.md`: avatar requirements and the manual Developer Portal steps.

### Known limitations

- A bot account may hold one voice connection per guild, so one session per
  server at a time.
- No spoken announcements: every cue is a generated tone.
- Sessions continue cycling indefinitely; there is no "finish after N cycles".

[Unreleased]: https://github.com/eccemono/marzano/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eccemono/marzano/releases/tag/v0.1.0
