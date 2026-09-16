# v0.1.0 release preparation

Status: **ready to tag once the checklist below is complete.**

This note is the handover for cutting the first release. Everything under
"Blocked on a human" requires credentials or judgement that the repository
cannot supply.

---

## What 0.1.0 is

The first working version. One Discord Pomodoro session per server, in a voice
channel, with shared focus and break cycles, per-channel configuration, in-VC
button controls, generated cue sounds and no FFmpeg dependency.

It is a complete product for its scope, not a preview: the timer survives
restarts, sessions reconcile themselves after an outage, and every failure path
in the audio layer degrades to silence rather than taking a session down.

---

## Pre-tag checklist

### Automated

- [x] `format:check`, `lint`, `typecheck`, `build` and `test` all pass
- [x] 320 tests across 20 suites
- [x] CI green on `main`: verify, CodeQL, dependency review
- [x] No token, `.env` file, database or host detail in the repository
- [x] No third-party image or audio asset committed
- [x] `CHANGELOG.md` has a dated `0.1.0` section
- [x] `README.md` documents installation, invite scope, commands, configuration
      precedence, the one-voice-connection limit and the Node 22 pin
- [x] `docs/OPERATIONS.md` covers start/stop, PM2, backup, restore and rollback
- [x] `docs/BRANDING.md` records the avatar placeholder and manual steps

### Blocked on a human

- [ ] Bot avatar chosen, licence recorded in `docs/BRANDING.md`, uploaded
- [ ] Application description and bot bio set in the Developer Portal
- [ ] Repository link set in the Developer Portal
- [ ] `DISCORD_TOKEN` written to `/opt/marzano/.env` on the host
- [ ] Production deployment verified end to end

---

## Cutting the release

Once the host is running the merged `main`:

```bash
git checkout main
git pull --ff-only
git tag -a v0.1.0 -m "Marzano v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-from-tag
```

The release notes should lead with what the bot does, then the two decisions
worth knowing about:

1. **No FFmpeg.** Cue sounds are pre-encoded to Opus in-process, because the
   production host does not have FFmpeg and a shell-out to a missing binary is
   the usual reason bot audio fails in production.
2. **The bot only ever changes its own voice state.** It never asks for
   permission to move, mute or disconnect anyone else, and it requests no
   privileged intents - Message Content stays off, which is why every entry
   point is a slash command.

---

## Known issues at 0.1.0

None that block a release. The following are understood and documented rather
than fixed:

| Item | Status |
| --- | --- |
| `vitest` v4 major upgrade (Dependabot) | Deferred; v3 is supported and passing |
| Two moderate advisories in the dependency tree | Assessed below |
| Sessions cycle indefinitely | By design; there is no "stop after N cycles" |

### Dependency advisories

`npm audit` reports two moderate findings, both the same one:

```
@vitest/mocker  2.1.0 - 4.1.10
Vitest: Path Traversal / Arbitrary File Read via @vitest/mocker Redirect Mock
GHSA-82fw-gwwq-j7x9
```

**This is a `devDependency`.** Vitest is a test runner; it is not in the
production dependency graph at all. Deploys install with `npm ci --omit=dev`,
so the vulnerable package is never present on the host and cannot be reached by
anything at runtime.

The only offered fix is `vitest@5.0.1`, a breaking major upgrade. Taking it now
would rewrite the test suite for a vulnerability that cannot exist in
production. The pragmatic order is: upgrade deliberately, as its own change,
after the release.

This is recorded so the decision is visible rather than silently ignored.

---

## After the release

1. Deploy `main` to the host and confirm `/info` shows `0.1.0`.
2. Start a session in a real voice channel and let one full focus period elapse.
3. Confirm the bot leaves when the last participant does, after the grace
   period.
4. Restart the process mid-session and confirm it recovers the correct stage.
5. Confirm `legatus`, `legatus-web`, `bump-bot` and `bump-manager` are untouched.
