#!/usr/bin/env bash
#
# Deploy Marzano on the Hetzner host.
#
# This script runs ON the server. It is invoked over SSH by
# .github/workflows/deploy.yml, and can also be run by hand for a manual
# deploy.
#
# It touches exactly one PM2 process: `marzano`. This host runs several
# unrelated services that must never be named, selected or reloaded from here -
# `--only ${APP_NAME}` is on every PM2 invocation for that reason.
#
# Every external command is overridable so the lifecycle test can stub it and
# exercise the failure and rollback paths without a real server.

set -Eeuo pipefail

GIT_BIN="${GIT_BIN:-git}"
NPM_BIN="${NPM_BIN:-npm}"
NODE_BIN="${NODE_BIN:-/usr/local/lib/nodejs/node-v22.23.2-linux-x64/bin/node}"

# npm has to run under the pinned interpreter. Its shebang is
# `#!/usr/bin/env node`, so pointing NPM_BIN at a path is not enough on its own:
# `node` is resolved from PATH, and this host's system node is 24.x. Left alone,
# `npm ci` builds native modules (better-sqlite3, @discordjs/opus) against Node
# 24's ABI while the app runs on Node 22, and the process crash-loops on startup.
export PATH="$(dirname "$NODE_BIN"):$PATH"

PM2_BIN="${PM2_BIN:-pm2}"
SQLITE_BIN="${SQLITE_BIN:-sqlite3}"

APP_NAME="marzano"
BRANCH="${DEPLOY_BRANCH:-main}"
APP_DIR="${MARZANO_APP_DIR:-/opt/marzano}"
DATA_DIR="${MARZANO_DATA_DIR:-/srv/marzano}"
HEALTH_FILE="${DATA_DIR}/health.json"
BACKUP_DIR="${MARZANO_BACKUP_DIR:-/srv/marzano/backups}"
BACKUP_KEEP="${MARZANO_BACKUP_KEEP:-5}"

# Must exceed the app's own SHUTDOWN_TIMEOUT_MS and PM2's kill_timeout.
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"
HEALTH_POLL_SECONDS="${HEALTH_POLL_SECONDS:-2}"

readonly EXIT_ENV=10
readonly EXIT_GIT=11
readonly EXIT_INSTALL=12
readonly EXIT_BUILD=13
readonly EXIT_HEALTH=14

# Diagnostics go to stderr so that command substitution around functions which
# log (pull_main, rollback) captures only the value they return.
log() { printf '[deploy] %s\n' "$*" >&2; }
fail() { printf '[deploy] ERROR: %s\n' "$*" >&2; }

# ── Environment gate ────────────────────────────────────────────────────────
# Fail before touching anything, rather than half way through a deploy.

gate() {
  local missing=0

  for name in MARZANO_APP_DIR MARZANO_DATA_DIR; do
    if [ -z "${!name:-}" ]; then
      fail "${name} is not set. Refusing to guess a path on a shared host."
      missing=1
    fi
  done

  if [ ! -d "$APP_DIR" ]; then
    fail "APP_DIR ${APP_DIR} does not exist."
    missing=1
  fi

  if [ ! -d "$APP_DIR/.git" ]; then
    fail "${APP_DIR} is not a git checkout."
    missing=1
  fi

  if ! "$NODE_BIN" --version >/dev/null 2>&1; then
    fail "The pinned Node interpreter ${NODE_BIN} is not executable."
    missing=1
  fi

  local node_major
  node_major="$("$NODE_BIN" --version | sed 's/^v//' | cut -d. -f1)"
  if [ "$node_major" != "22" ]; then
    fail "Pinned interpreter reports major ${node_major}; Marzano requires Node 22."
    missing=1
  fi

  if [ "$missing" -ne 0 ]; then
    fail "Environment gate failed. Nothing has been changed."
    exit "$EXIT_ENV"
  fi

  log "environment gate passed (node $( "$NODE_BIN" --version ), app ${APP_DIR}, data ${DATA_DIR})"
}

# ── Database backup ─────────────────────────────────────────────────────────

backup_database() {
  mkdir -p "$BACKUP_DIR"

  if [ ! -f "${DATA_DIR}/marzano.db" ]; then
    log "no database yet; skipping backup"
    return 0
  fi

  local stamp destination
  stamp="$(date +%Y%m%d-%H%M%S)"
  destination="${BACKUP_DIR}/marzano-${stamp}.db"

  # WAL mode means a plain copy can capture an inconsistent snapshot, so use
  # SQLite's own online backup.
  if ! "$SQLITE_BIN" "${DATA_DIR}/marzano.db" ".backup '${destination}'"; then
    fail "database backup failed; refusing to deploy over an unbacked-up database."
    exit "$EXIT_GIT"
  fi

  log "database backed up to ${destination}"

  # Keep only the most recent few, so a busy day cannot fill the disk.
  { ls -1t "${BACKUP_DIR}"/marzano-*.db 2>/dev/null || true; } \
    | tail -n "+$((BACKUP_KEEP + 1))" \
    | while read -r stale; do rm -f "$stale"; done
}

# ── Revision ────────────────────────────────────────────────────────────────

previous_revision() {
  "$GIT_BIN" -C "$APP_DIR" rev-parse HEAD
}

pull_main() {
  log "fetching origin/${BRANCH}"
  # stdout is reserved for the revision this function returns. `git fetch` and
  # `git merge` both write progress and summaries there, and `main` captures the
  # whole of it with $(...). Left alone, the captured "revision" becomes a
  # multi-line blob, the health check can never match it, and a healthy deploy
  # gets rolled back.
  "$GIT_BIN" -C "$APP_DIR" fetch --prune origin >&2

  local target
  target="$("$GIT_BIN" -C "$APP_DIR" rev-parse "origin/${BRANCH}")"

  # Refuse to deploy a dirty tree: it means someone edited on the host and the
  # deployed revision would not match any commit.
  if [ -n "$("$GIT_BIN" -C "$APP_DIR" status --porcelain)" ]; then
    fail "${APP_DIR} has uncommitted changes; refusing to deploy over them."
    exit "$EXIT_GIT"
  fi

  # Fast-forward only. A remote rewrite should stop the deploy, not silently
  # merge something nobody reviewed.
  if ! "$GIT_BIN" -C "$APP_DIR" merge --ff-only "$target" >&2; then
    fail "cannot fast-forward to ${target}; ${APP_DIR} has diverged from origin/${BRANCH}."
    exit "$EXIT_GIT"
  fi

  "$GIT_BIN" -C "$APP_DIR" rev-parse HEAD
}

install_dependencies() {
  # The build needs devDependencies - TypeScript above all - so install the full
  # tree, build, and prune afterwards. Installing with --omit=dev here would
  # make `npm run build` fail with "tsc: not found" on every single deploy.
  if ! (cd "$APP_DIR" && "$NPM_BIN" ci --no-audit --no-fund); then
    fail "dependency install failed."
    exit "$EXIT_INSTALL"
  fi
}

build() {
  if ! (cd "$APP_DIR" && "$NPM_BIN" run build); then
    fail "build failed."
    exit "$EXIT_BUILD"
  fi
}

prune_dependencies() {
  # Leave only what the running process needs on the host.
  if ! (cd "$APP_DIR" && "$NPM_BIN" prune --omit=dev --no-audit --no-fund); then
    fail "could not prune development dependencies."
    exit "$EXIT_INSTALL"
  fi
}

reload_app() {
  local commit="$1"
  log "reloading ${APP_NAME} only (at ${commit})"
  (cd "$APP_DIR" && GIT_COMMIT="$commit" "$PM2_BIN" startOrReload ecosystem.config.cjs --only "$APP_NAME" --update-env)
}

# ── Health ──────────────────────────────────────────────────────────────────

# Discard the previous revision's snapshot.
#
# This has to happen *before* the reload, not inside poll_health: the app writes
# a fresh snapshot as soon as it starts, and deleting it afterwards would throw
# away the very evidence the poll is waiting for.
clear_health() {
  rm -f "$HEALTH_FILE" "${HEALTH_FILE}.tmp"
}

poll_health() {
  local expected_commit="$1"
  local deadline=$(( SECONDS + HEALTH_TIMEOUT_SECONDS ))

  while [ "$SECONDS" -lt "$deadline" ]; do
    if [ -f "$HEALTH_FILE" ]; then
      local ready commit
      ready="$(sed -n 's/.*"ready"[[:space:]]*:[[:space:]]*\(true\|false\).*/\1/p' "$HEALTH_FILE" | head -1)"
      commit="$(sed -n 's/.*"commit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$HEALTH_FILE" | head -1)"

      if [ "$ready" = "true" ] && [ "$commit" = "$expected_commit" ]; then
        log "health OK (ready, commit ${commit})"
        return 0
      fi
    fi

    sleep "$HEALTH_POLL_SECONDS"
  done

  fail "health check timed out after ${HEALTH_TIMEOUT_SECONDS}s."
  return 1
}

# ── Rollback ────────────────────────────────────────────────────────────────

rollback() {
  local target="$1"
  local failed_commit="$2"

  fail "rolling back to ${target}"
  "$GIT_BIN" -C "$APP_DIR" reset --hard "$target"

  if ! (cd "$APP_DIR" && "$NPM_BIN" ci --no-audit --no-fund); then
    fail "rollback dependency install failed; ${APP_NAME} is left on the broken revision."
    return 1
  fi

  if ! (cd "$APP_DIR" && "$NPM_BIN" run build); then
    fail "rollback build failed; ${APP_NAME} is left on the broken revision."
    return 1
  fi

  if ! (cd "$APP_DIR" && "$NPM_BIN" prune --omit=dev --no-audit --no-fund); then
    fail "rollback could not prune development dependencies."
    return 1
  fi

  clear_health
  reload_app "$target"

  if poll_health "$target"; then
    log "rollback to ${target} succeeded"
    fail "deploy of ${failed_commit} FAILED and was rolled back. Investigate before retrying."
  else
    fail "rollback to ${target} did NOT become healthy. Manual intervention required."
  fi
}

# ── Main ────────────────────────────────────────────────────────────────────

main() {
  gate
  backup_database

  local before
  before="$(previous_revision)"
  log "current revision: ${before}"

  local target
  if ! target="$(pull_main)"; then
    fail "could not update to origin/${BRANCH}."
    exit "$EXIT_GIT"
  fi

  if [ "$target" = "$before" ]; then
    log "already at ${target}; reloading anyway to pick up configuration changes"
  fi

  install_dependencies
  build
  prune_dependencies
  clear_health
  reload_app "$target"
  # Schema migrations run inside the app at startup, so a successful health
  # check below is what proves they completed.

  if poll_health "$target"; then
    log "deploy complete: ${target} (${APP_NAME} only; no other process was touched)"
    exit 0
  fi

  rollback "$before" "$target"
  exit "$EXIT_HEALTH"
}

# Run main unless this file was *sourced* (the lifecycle test does that to call
# individual functions). BASH_SOURCE is unset when the script arrives on stdin
# via `bash -s`, which is how the workflow invokes it, so fall back to $0 there.
if [ "${BASH_SOURCE[0]:-$0}" = "${0}" ]; then
  main "$@"
fi
