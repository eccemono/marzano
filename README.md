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
- A Discord application with a bot user.

FFmpeg is **not** required. Cue sounds are pre-encoded to Opus in-process, so
the audio path has no external binary in it and cannot fail because a host is
missing one. See [Cue sounds](#cue-sounds).

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

### Inviting the bot

Marzano needs **only five permissions**, and asks for no privileged intents:

| Permission | Why |
| --- | --- |
| View Channels | To see the voice channel a command was used in |
| Send Messages | To post the status message |
| Embed Links | The status message is an embed |
| Connect | To join the voice channel |
| Speak | To play the cue sounds |

`bot` and `applications.commands` are the only OAuth2 scopes required:

```
https://discord.com/oauth2/authorize?client_id=YOUR_APP_ID&scope=bot+applications.commands&permissions=3165184
```

`3165184` is exactly the five permissions above. **Do not grant Administrator.**

To also mirror the stage into the voice channel's status line, add Set Voice
Channel Status — that is `281474979875840`. This is optional and off by default
(`VOICE_STATUS_ENABLED`); leave it out and everything else works unchanged.
Marzano never needs it: it only ever changes its own voice state, and it never
requests permission to move, mute or disconnect anyone else.

### Enabling the bot

1. Create an application at <https://discord.com/developers/applications>.
2. Under **Bot**, reset the token and copy it. Put it in `.env` directly on the
   host - never paste it into chat, an issue, or a commit.
3. Under **Installation**, add the `bot` and `applications.commands` scopes and
   the five permissions above.
4. Invite the bot with the URL above.

No privileged intents need enabling in the Developer Portal. **Message Content
stays off**, which is why `/info` and every other entry point is a slash
command: Marzano never reads message text.

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
| `SOUNDS_DIR` | no | `./assets/sounds` | Directory holding the generated cue sounds. |
| `GRACE_MS` | no | `60000` | How long the last participant can be absent before the session ends. |
| `SHUTDOWN_TIMEOUT_MS` | no | `5000` | Bound on graceful shutdown. Must be under the process manager's kill timeout. |
| `DEV_GUILD_ID` | no | - | Register commands in one guild for instant updates while developing. |

FFmpeg is not required and `FFMPEG_PATH` is no longer used by the audio path;
see [Cue sounds](#cue-sounds).

### Configuration precedence

Settings are layered, and the highest layer that mentions a field wins:

```
built-in defaults  →  server defaults  →  voice-channel settings  →  in-session changes
```

Each layer only states what it changes, so a channel can override its split
without restating the sound settings. **In-session changes** - the Modify menu's
sound toggle or split change - apply to the running session only and never write
back to the saved channel configuration.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/pomodoro [split]` | VC participants | Starts a cycle in the voice channel you are in. |
| `/start [split]` | VC participants | Exactly the same command, under the name people instinctively try. |
| `@Marzano` | VC participants | Also starts a session. No prefix, and no Message Content intent. |
| `/status` | anyone | Shows the current stage, cycle and remaining time. |
| `/configure` | Manage Channels | Sets the split, sound and volume for this channel. |
| `/default` | Manage Guild | Server-wide defaults for newly configured channels. |
| `/stop` | VC participants | Ends the session and posts the summary. |
| `/leaderboard [period]` | anyone | Monthly, yearly or all-time time in Pomodoro. |
| `/info` | anyone | Version, uptime, latency and a link to this repository. |

`/pomodoro` and `/start` are deliberately two names for one action: starting a
session is what people type most, and making them pick a subcommand first was
friction for no benefit. Passing a split (`/pomodoro 50 10 5`) always overrides
the channel's saved settings for that session only.

Mentioning the bot works because `GuildMessages` is enabled — that is a
**non-privileged** intent that delivers the message event and the mention
metadata, but *not* the message text. Discord only fills in `message.content`
if the privileged Message Content intent is also on. A `!pomodoro` prefix would
require that privileged intent, which is exactly why there isn't one.

Session controls are buttons on the status message rather than commands, and
every press re-checks that you are in the session's voice channel.

| Control | Who | Notes |
| --- | --- | --- |
| Pause / Resume | participants | |
| Skip | participants | Asks for confirmation |
| Stop | participants | Asks for confirmation |
| Modify | participants | +2 min, +5 min, change split, sound on/off |

Members with **Manage Channels** may force-stop a session they are not part of,
so a session whose participants all left cannot hold the bot's single voice
connection indefinitely. They cannot pause, skip or modify one from outside,
because those change what the people actually in the call are doing.

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
- **No spoken announcements.** Every cue is a generated tone. Marzano has no
  text-to-speech and no voice announcements; stage changes are marked by a bell
  alone.
- **Sounds come from generated assets.** No third-party audio is bundled, so the
  bells are synthesised by a script in this repository.
- **A session ends when everyone leaves.** After a 60 second grace period
  (`GRACE_MS`) with nobody in the channel, the session stops. The grace period
  cancels if someone returns.
- **Offline time is caught up, but silently.** If the bot restarts mid-session
  it advances across any boundaries that elapsed while it was down. The bells
  for those boundaries are deliberately not replayed; the count is logged.

## Cue sounds

The bells are **generated, not bundled**. `assets/sounds/start.wav` and
`assets/sounds/bell.wav` are the reproducible output of a script in this
repository, so there is no third-party audio to license and no opaque binary of
unknown provenance in the tree.

```bash
npm run sounds      # regenerates assets/sounds/*.wav
```

The synthesis is pure arithmetic - summed sine partials under an exponential
decay envelope - with no randomness and no reliance on the platform audio
stack. Regenerating always produces byte-identical files, and a test asserts
that the committed files match what the generator produces, which is what keeps
them honest rather than arbitrary.

| Sound | Played | Length |
| --- | --- | --- |
| `start.wav` | Once, at session start, before the first bell | 1.10 s |
| `bell.wav` | At every stage boundary, including the first | 2.00 s |

Later stage transitions play the bell **only**. The start cue is never replayed
mid-session, so a break beginning always sounds different from a session
beginning.

### No FFmpeg

`@discordjs/voice` can transmit Opus packets directly, so Marzano encodes the
cue sounds to Opus in-process with the pure-JS `opusscript` encoder and sends
them as `StreamType.Opus`. FFmpeg is never invoked and is not installed on the
production host.

`opusscript` is chosen over a native binding precisely because it has no
prebuilt-ABI requirement: a Node major upgrade cannot break it, and it cannot
fail on a server whose architecture has no prebuilt binary.

Two consequences worth stating plainly:

- **Volume is applied before encoding.** Each (sound, volume) pair is encoded
  once and cached, so a volume change costs one encode rather than one per
  playback.
- **Every audio failure ends in a log line, not an exception.** A missing asset,
  an unusable encoder or a dropped voice connection degrades to silence. The
  timer is independent of audio and is never blocked or failed by it.

## Architecture

```
src/
  index.ts            entry point: validates runtime and configuration
  runtime.ts          build identity and the Node major guard
  logger.ts           structured JSON logging with mandatory secret redaction
  config/env.ts       environment loading and validation
  commands/           slash command definitions, wizard flows, /info
  db/                 SQLite migrations and repositories
  domain/             pure, Discord-free logic (no I/O)
    split.ts            split parsing and validation
    config.ts           layered configuration precedence
    timer.ts            timestamp-based session state machine
    serializer.ts       per-guild serialization of state changes
  discord/            thin presentation layer
    handlers.ts         interaction routing
    session-view.ts     status embed rendering
    session-controls.ts control authorization rules
  voice/              audio, behind an interface
    wav.ts              minimal RIFF/WAVE read and write
    tones.ts            deterministic synthesis
    opus.ts             PCM to Opus, pure JS
    sounds.ts           cached, volume-aware sound library
    gateway.ts          the @discordjs/voice boundary
    manager.ts          join/play/leave orchestration
assets/sounds/        generated cue sounds
scripts/              the sound generator
tests/                vitest suites
```

The split is deliberate: everything under `domain/` and `voice/` is testable
without a Discord connection, and `discord/` is kept thin enough to be reviewed
by reading.

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
