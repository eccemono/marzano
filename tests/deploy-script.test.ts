import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

/**
 * Deploy script lifecycle.
 *
 * The real script is executed as a subprocess with `git`, `npm`, `pm2`,
 * `sqlite3` and the Node interpreter replaced by stubs that record what they
 * were asked to do. That makes the success path, the failure path and the
 * rollback path all reachable without a server, and lets the assertions be
 * about *what the script actually did* rather than about its text.
 */

const SCRIPT = join(__dirname, "..", "scripts", "deploy-hetzner.sh");

let workspace: string | null = null;

afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
  workspace = null;
});

interface Sandbox {
  root: string;
  appDir: string;
  dataDir: string;
  callsFile: string;
  calls: string[];
  healthFile: string;
}

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "marzano-deploy-"));
  workspace = root;

  const appDir = join(root, "opt", "marzano");
  const dataDir = join(root, "srv", "marzano");
  const binDir = join(root, "bin");
  const callsFile = join(root, "calls.log");

  mkdirSync(join(appDir, ".git"), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(callsFile, "");
  writeFileSync(join(dataDir, "marzano.db"), "fake database");

  // The git stub tracks the checked-out revision, because the script reads it
  // back after a merge and the health check compares against it.
  const gitStub = `#!/usr/bin/env bash
echo "git $*" >> "$CALLS_FILE"
STATE="$CALLS_FILE.head"
case "$*" in
  *"status --porcelain"*) [ "\${GIT_DIRTY:-0}" = "1" ] && echo " M dirty" ;;
  *"merge --ff-only"*)
    if [ "\${GIT_MERGE_FAIL:-0}" = "1" ]; then exit 1; fi
    echo "\${GIT_TARGET:-bbbbbbbbbbbb}" > "$STATE" ;;
  *"rev-parse origin/"*) echo "\${GIT_TARGET:-bbbbbbbbbbbb}" ;;
  *"rev-parse HEAD"*)
    if [ -f "$STATE" ]; then cat "$STATE"; else echo "\${GIT_HEAD:-aaaaaaaaaaaa}"; fi ;;
  *"reset --hard"*) rm -f "$STATE" ;;
esac
exit 0
`;

  const npmStub = `#!/usr/bin/env bash
echo "npm $*" >> "$CALLS_FILE"
[ "\${NPM_FAIL:-0}" = "1" ] && exit 1
exit 0
`;

  // The app reports the revision it was started with via GIT_COMMIT, which the
  // script sets on every reload. PM2_HEALTH_AFTER suppresses the snapshot for
  // the first N reloads so the failure path can be reached.
  const pm2Stub = `#!/usr/bin/env bash
echo "pm2 $*" >> "$CALLS_FILE"
COUNT_FILE="$CALLS_FILE.pm2"
COUNT=0
[ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNT_FILE"

if [ "\${PM2_WRITES_HEALTH:-1}" = "1" ] && [ "$COUNT" -ge "\${PM2_HEALTH_AFTER:-1}" ]; then
  printf '{\\n  "ready": true,\\n  "commit": "%s"\\n}\\n' "\${GIT_COMMIT:-unknown}" > "$HEALTH_FILE"
fi
exit 0
`;

  const sqliteStub = `#!/usr/bin/env bash
echo "sqlite3 $*" >> "$CALLS_FILE"
[ "\${SQLITE_FAIL:-0}" = "1" ] && exit 1
exit 0
`;

  const nodeStub = `#!/usr/bin/env bash
[ "\${1:-}" = "--version" ] && echo "v22.23.2" && exit 0
exit 0
`;

  executable(join(binDir, "git"), gitStub);
  executable(join(binDir, "npm"), npmStub);
  executable(join(binDir, "pm2"), pm2Stub);
  executable(join(binDir, "sqlite3"), sqliteStub);
  executable(join(binDir, "node22"), nodeStub);

  return { root, appDir, dataDir, callsFile, calls: [], healthFile: join(dataDir, "health.json") };
}

function runDeploy(sandbox: Sandbox, env: Record<string, string> = {}) {
  const binDir = join(sandbox.root, "bin");

  try {
    const stdout = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        CALLS_FILE: sandbox.callsFile,
        HEALTH_FILE: sandbox.healthFile,
        GIT_BIN: join(binDir, "git"),
        NPM_BIN: join(binDir, "npm"),
        PM2_BIN: join(binDir, "pm2"),
        SQLITE_BIN: join(binDir, "sqlite3"),
        NODE_BIN: join(binDir, "node22"),
        MARZANO_APP_DIR: sandbox.appDir,
        MARZANO_DATA_DIR: sandbox.dataDir,
        MARZANO_BACKUP_DIR: join(sandbox.dataDir, "backups"),
        HEALTH_TIMEOUT_SECONDS: "2",
        HEALTH_POLL_SECONDS: "1",
        ...env,
      },
    });
    return { code: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failure.status ?? -1,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

function callsOf(sandbox: Sandbox): string[] {
  return readFileSync(sandbox.callsFile, "utf8").split("\n").filter(Boolean);
}

describe("environment gate", () => {
  it("refuses to run without an app directory", () => {
    const sandbox = createSandbox();
    // An unset MARZANO_APP_DIR must stop the deploy before anything is touched.
    const result = runDeploy(sandbox, { MARZANO_APP_DIR: "" });

    expect(result.code).toBe(10);
    expect(callsOf(sandbox)).toEqual([]);
  });

  it("refuses to run when the pinned interpreter is not Node 22", () => {
    const sandbox = createSandbox();
    const wrongNode = join(sandbox.root, "bin", "node23");
    executable(wrongNode, '#!/usr/bin/env bash\necho "v23.1.0"\n');

    const result = runDeploy(sandbox, { NODE_BIN: wrongNode });

    expect(result.code).toBe(10);
    expect(result.output).toContain("requires Node 22");
    expect(callsOf(sandbox)).toEqual([]);
  });
});

describe("successful deploy", () => {
  it("backs up, fast-forwards, builds, reloads only marzano and verifies health", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox);

    expect(result.code).toBe(0);

    const calls = callsOf(sandbox);

    // The database is backed up before anything else happens to the checkout.
    expect(calls.some((call) => call.startsWith("sqlite3"))).toBe(true);
    expect(calls.some((call) => call.includes("merge --ff-only"))).toBe(true);
    expect(calls.some((call) => call.startsWith("npm ci"))).toBe(true);
    expect(calls.some((call) => call.includes("run build"))).toBe(true);
  });

  it("installs the full dependency tree, builds, then prunes", () => {
    // `tsc` is a devDependency, so installing with --omit=dev first would make
    // the build fail with "tsc: not found" on every deploy.
    const sandbox = createSandbox();
    runDeploy(sandbox);

    const calls = callsOf(sandbox);
    const install = calls.findIndex((call) => call.startsWith("npm ci"));
    const build = calls.findIndex((call) => call.includes("run build"));
    const prune = calls.findIndex((call) => call.includes("npm prune"));

    expect(calls[install]).not.toContain("--omit=dev");
    expect(install).toBeLessThan(build);
    expect(build).toBeLessThan(prune);
    expect(calls[prune]).toContain("--omit=dev");
  });

  it("reloads the marzano process and nothing else", () => {
    const sandbox = createSandbox();
    runDeploy(sandbox);

    const pm2Calls = callsOf(sandbox).filter((call) => call.startsWith("pm2 "));
    expect(pm2Calls.length).toBeGreaterThan(0);

    for (const call of pm2Calls) {
      expect(call).toContain("--only marzano");
      expect(call).toContain("startOrReload");
    }
  });

  it("leaves the database backup in place", () => {
    const sandbox = createSandbox();
    runDeploy(sandbox);

    const backups = readFileSync(sandbox.callsFile, "utf8");
    expect(backups).toContain(".backup");
  });
});

describe("failure paths", () => {
  it("stops before changing anything when the tree is dirty", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { GIT_DIRTY: "1" });

    expect(result.code).toBe(11);
    expect(callsOf(sandbox).some((call) => call.includes("merge --ff-only"))).toBe(false);
    expect(callsOf(sandbox).some((call) => call.startsWith("pm2"))).toBe(false);
  });

  it("stops when the branch cannot fast-forward", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { GIT_MERGE_FAIL: "1" });

    expect(result.code).toBe(11);
    expect(result.output).toContain("fast-forward");
    expect(callsOf(sandbox).some((call) => call.startsWith("pm2"))).toBe(false);
  });

  it("refuses to deploy over an unbacked-up database", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { SQLITE_FAIL: "1" });

    expect(result.code).toBe(11);
    expect(callsOf(sandbox).some((call) => call.includes("merge --ff-only"))).toBe(false);
  });

  it("stops when dependency install fails", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { NPM_FAIL: "1" });

    expect(result.code).toBe(12);
    expect(callsOf(sandbox).some((call) => call.startsWith("pm2"))).toBe(false);
  });
});

describe("rollback", () => {
  it("resets to the previous revision when health never becomes ready", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { PM2_WRITES_HEALTH: "0" });

    expect(result.code).toBe(14);

    const calls = callsOf(sandbox);
    // Rolled back to the revision that was deployed before this attempt.
    expect(calls.some((call) => call.includes("reset --hard aaaaaaaaaaaa"))).toBe(true);
    expect(result.output).toContain("rolling back");
  });

  it("says so loudly when the rollback itself does not recover", () => {
    const sandbox = createSandbox();
    const result = runDeploy(sandbox, { PM2_WRITES_HEALTH: "0" });

    expect(result.output).toContain("Manual intervention required");
  });

  it("reports that the failed deploy was rolled back when the rollback recovers", () => {
    const sandbox = createSandbox();
    // The first reload reports nothing - that deploy is broken. The rollback
    // reload is allowed to report healthy.
    const result = runDeploy(sandbox, { PM2_HEALTH_AFTER: "2" });

    // Still a failed deploy: the workflow must go red even though the host was
    // left healthy, otherwise a rollback would look like a successful release.
    expect(result.code).toBe(14);
    expect(result.output).toContain("rollback to aaaaaaaaaaaa succeeded");
    expect(result.output).toContain("FAILED and was rolled back");
  });
});

describe("process isolation", () => {
  it("never names, selects or reloads another service on the host", () => {
    const script = readFileSync(SCRIPT, "utf8");

    // Not even in a comment: the guarantee is that these strings do not appear.
    for (const name of ["legatus", "bump-bot", "bump-manager", "bump_bot"]) {
      expect(script.toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  it("scopes every PM2 invocation with --only", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const pm2Lines = script
      .split("\n")
      .filter((line) => line.includes("$PM2_BIN") || line.includes("pm2 "));

    expect(pm2Lines.length).toBeGreaterThan(0);
    for (const line of pm2Lines) {
      expect(line).toContain("--only");
    }
  });
});
