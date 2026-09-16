# Operations

Running Marzano in production on the Hetzner host (`cloudboi`).

Marzano runs under PM2 alongside other services. **Nothing in this document
should ever touch a process that is not `marzano`.**

---

## Host layout

| Path | Purpose |
| --- | --- |
| `/opt/marzano` | The checkout. Code lives here. |
| `/opt/marzano/.env` | Secrets and configuration. Never committed, never echoed. |
| `/srv/marzano` | Runtime state: the SQLite database. Survives redeploys. |
| `/srv/marzano/marzano.db` | The database itself. |

Keeping state outside the checkout is deliberate: a redeploy replaces the code
directory without touching a single byte of session or configuration data.

### The Node pin

The host's system Node is **24.x**, which must not be used. Node 24 carries the
ObjectWrap cleanup-hook regression that aborts the process inside native SQLite
bindings ([nodejs/node#65446](https://github.com/nodejs/node/issues/65446)).

Marzano is pinned to **Node 22**:

```
/usr/local/lib/nodejs/node-v22.23.2-linux-x64/bin/node
```

This path is baked into the PM2 configuration. The bot also refuses to start on
any major other than 22, so a misconfiguration fails loudly at boot instead of
aborting unpredictably some hours later.

---

## Day-to-day

```bash
# Status of the Marzano process only
pm2 describe marzano

# Recent logs
pm2 logs marzano --lines 100

# Restart (no downtime for other services)
pm2 restart marzano

# Reload with zero downtime
pm2 reload marzano
```

All commands target `marzano` explicitly. **Never run `pm2 restart all`,
`pm2 delete all`, or `pm2 save --force`** - that would restart Legatus, its web
frontend, and the bump bot.

### Checking health

```bash
pm2 describe marzano | grep -E "status|restarts|uptime"
curl -s localhost:3000/health   # once the heartbeat task lands
```

A steadily climbing restart count means the process is crash-looping. Check the
logs before restarting again.

---

## Logs

| What | Where |
| --- | --- |
| Application output | `pm2 logs marzano` |
| PM2 error log | `~/.pm2/logs/marzano-error.log` |
| PM2 output log | `~/.pm2/logs/marzano-out.log` |

Application logs are single-line JSON, so they are safe to pipe into `jq`:

```bash
pm2 logs marzano --json | jq 'select(.level == "error")'
```

**Logs never contain credentials.** Every value passes through redaction on the
way out, and Marzano does not request the Message Content intent, so it never
receives message text in the first place. A log bundle is therefore safe to
share.

### Log rotation

```bash
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 7
```

---

## Backup and restore

The database is the only stateful artefact.

### Back up

SQLite is in WAL mode, so a plain `cp` can capture an inconsistent snapshot.
Use the online backup command instead:

```bash
ssh root@HOST 'sqlite3 /srv/marzano/marzano.db ".backup /srv/marzano/backup-$(date +%F-%H%M).db"'
```

Then pull it down:

```bash
scp root@HOST:/srv/marzano/backup-*.db ./backups/
```

### Restore

```bash
ssh root@HOST
pm2 stop marzano
cp /srv/marzano/marzano.db /srv/marzano/marzano.db.before-restore
cp /srv/marzano/backup-2026-01-01-1200.db /srv/marzano/marzano.db
rm -f /srv/marzano/marzano.db-wal /srv/marzano/marzano.db-shm
pm2 start marzano
pm2 logs marzano --lines 50
```

Removing the `-wal` and `-shm` files matters: a stale write-ahead log from a
different database file will corrupt the restore.

After restoring, check the log line `database ready` to confirm the schema
version, and confirm any active sessions were reconciled under `recovery
complete`.

---

## Deploying

```bash
ssh root@HOST
cd /opt/marzano
git pull --ff-only
npm ci --omit=dev
npm run build
pm2 reload marzano
```

The deploy script automates this with a health check and rollback; run it
instead of doing the steps by hand once it exists.

### Rolling back

```bash
ssh root@HOST
cd /opt/marzano
git log --oneline -5              # find the last good commit
git checkout <good-sha>
npm ci --omit=dev
npm run build
pm2 reload marzano
```

Confirm with `pm2 describe marzano` and a `/info` in Discord. When the fix is
ready, `git checkout main && git pull` to return to the branch.

`/srv/marzano` is untouched by any rollback, so sessions and configuration
survive it.

---

## Shutdown behaviour

`SIGINT` and `SIGTERM` trigger a graceful shutdown: timers are cancelled,
elapsed session state is flushed to the database, and the bot leaves Discord
within `SHUTDOWN_TIMEOUT_MS` (default 5 s).

**This must stay below PM2's `kill_timeout`.** If PM2's timeout is shorter, the
process is killed mid-shutdown and the bot disappears from Discord without
leaving its voice channel cleanly. The PM2 configuration sets a `kill_timeout`
above the application's own bound for exactly this reason.

---

## Recovering a stuck session

Sessions reconcile themselves on restart. If one is wedged:

1. `pm2 restart marzano` - the bot advances across elapsed boundaries and
   rejoins only if people are still in the channel.
2. If it remains stuck, read the row directly:

   ```bash
   sqlite3 /srv/marzano/marzano.db "SELECT guild_id, voice_channel_id, stage, state, stop_reason FROM active_sessions;"
   ```

   A non-null `stop_reason` explains why a session ended.
3. As a last resort, delete the row to free the guild:

   ```bash
   sqlite3 /srv/marzano/marzano.db "DELETE FROM active_sessions WHERE guild_id = '<id>';"
   pm2 restart marzano
   ```

---

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Exits at startup mentioning Node | Wrong Node binary | Check the pin in the PM2 config |
| `Missing required environment variable` | `.env` absent or incomplete | Fix `.env`, then restart |
| Bot online, no audio | Voice connect or Speak permission | Re-invite with the documented permissions |
| `cue sound unavailable` in logs | Assets missing | `npm run sounds`, then restart |
| Session ends immediately | Nobody in the channel | Expected after the grace period |
| Restart count climbing | Crash loop | Read the error log before restarting |

---

## What not to touch

| Process | Note |
| --- | --- |
| `legatus` | Separate service |
| `legatus-web` | Separate service |
| `bump-bot` | Separate service |
| `bump-manager` | Separate service |

Only ever operate on `marzano`.
