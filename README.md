# Marzano

A Discord Pomodoro bot built for **voice channels**. Marzano runs shared focus and
break cycles with the people in your VC, keeps a live timer in the channel chat,
and lets anyone in the call pause, skip or extend the current block.

Named after the San Marzano tomato: small, focused, and best in a group.

> **Status: under construction.** The repository currently contains the project
> foundation - toolchain, configuration loading, structured logging and the CI
> gates. The timer engine, Discord commands and voice audio land in the tasks
> listed under [Roadmap](#roadmap). The commands below describe the intended
> behaviour, not a finished product.

## Why

Most Pomodoro bots are either a stopwatch in your DMs or a heavyweight study
suite. Marzano targets a narrower case: a group of people already sitting in the
same voice channel who want the bot to hold the structure for them, without
anyone having to watch a clock.

## Design principles

- **Timestamps, not tick counters.** Remaining time is derived from stored
  deadlines, so the timer cannot drift and it survives a restart.
- **Configuration is per voice channel.** A channel remembers its own split.
  Temporary in-session tweaks never overwrite the saved configuration.
- **Anyone in the call can steer.** Pause, resume, extend and skip are open to
  current voice-channel participants. Permanent configuration is not.
- **Audio failures never kill a session.** If FFmpeg or the voice connection
  dies, the visible timer keeps running.

## Requirements

- **Node.js 22.x** - pinned in `.nvmrc` and asserted at startup.
- **FFmpeg** on the host, for voice audio transcoding.
- A Discord application with a bot user.

### Why Node 22 specifically

Node 24.x (>= 24.19.0) carries the ObjectWrap cleanup-hook regression that
aborts the process inside native SQLite bindings
([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)). Marzano
refuses to start on any major other than 22 rather than risk an unexplained
`SIGABRT` in production.

## Getting started

```bash
git clone https://github.com/eccemono/marzano.git
cd marzano
npm ci

cp .env.example .env
# edit .env and add DISCORD_TOKEN and CLIENT_ID

npm run build
npm start
```

## Development

```bash
npm run dev          # watch mode via tsx
npm run typecheck    # tsc --noEmit
npm run lint         # biome lint
npm run format       # biome format --write
npm run test         # vitest
```

The full gate that CI enforces is:

```bash
npm ci && npm run format:check && npm run lint && npm run typecheck && npm run build && npm test
```

## Configuration

All configuration comes from the environment. See `.env.example` for the
annotated list.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `DISCORD_TOKEN` | yes | - | Bot token. Never commit it. |
| `CLIENT_ID` | yes | - | Application ID, used to register slash commands. |
| `LOG_LEVEL` | no | `info` | `debug`, `info`, `warn` or `error`. |
| `DATA_DIR` | no | `./data` | Where the SQLite database lives. Production uses `/srv/marzano`. |
| `FFMPEG_PATH` | no | `ffmpeg` | Path to the FFmpeg binary. |
| `DEV_GUILD_ID` | no | - | Register commands in one guild for instant updates while developing. |

## Commands

> Intended interface; implemented across the roadmap tasks below.

| Command | Who | What it does |
| --- | --- | --- |
| `/pomodoro start [split]` | VC participants | Starts a cycle in the voice channel you are in. |
| `/pomodoro status` | anyone | Shows the current stage, cycle and remaining time. |
| `/pomodoro configure` | Manage Channels | Sets the split, sound and volume for this channel. |
| `/pomodoro default` | Manage Guild | Server-wide defaults for newly configured channels. |
| `/pomodoro stop` | VC participants | Ends the session. |
| `/info` | anyone | Version, uptime, latency and a link to this repository. |

### Split syntax

Splits can be typed flexibly:

| Input | Meaning |
| --- | --- |
| `25` | 25 minute focus, 5 minute short break, 15 minute long break |
| `25 5` | focus 25, short break 5, long break inferred as twice the short break |
| `25 5 15` | focus 25, short break 5, long break 15 |
| `25-5-15` | same, dash separated |

## Known limitations

- **One voice connection per guild.** Discord allows a bot account a single
  voice connection per server. If Marzano is already running in one voice
  channel, a second `start` is rejected and points at the channel that owns the
  session. Separate servers can run sessions concurrently.
- **No spoken announcements.** Discord gives bots no text-to-speech. The
  starting cue is committed audio, not synthesised speech.
- **Sounds come from generated assets.** No third-party audio is bundled, so the
  bells are synthesised by a script in this repository.

## Architecture

```
src/
  index.ts        entry point: validates runtime and configuration
  runtime.ts      build identity and the Node major guard
  logger.ts       structured JSON logging with mandatory secret redaction
  config/env.ts   environment loading and validation
tests/            vitest suites for the above
```

Planned additions follow the same split: a pure, Discord-free timer domain, a
persistence layer, and a thin Discord presentation layer.

## Deployment

Marzano runs under PM2 on a Hetzner host, alongside - but fully isolated from -
other services. The deploy path pulls `main`, builds, migrates and reloads only
the `marzano` process. See `docs/OPERATIONS.md` once the deployment task lands.

## Roadmap

| Task | Scope |
| --- | --- |
| Foundation | Repo, toolchain, CI, logging, config |
| Domain | Split parser, configuration precedence, SQLite persistence |
| Timer | Timestamp-based state machine with pause, skip and extend |
| Commands | Slash commands, configuration wizard, permissions |
| Session UI | Status embed, buttons, confirmations |
| Voice | Voice connection, generated bell assets, mute/deafen |
| Lifecycle | Single-session enforcement, grace period, restart recovery |
| Hardening | End-to-end tests, failure injection, runbook |
| Release | PM2 lifecycle, safe deploy with rollback |

## License

[MIT](LICENSE)
