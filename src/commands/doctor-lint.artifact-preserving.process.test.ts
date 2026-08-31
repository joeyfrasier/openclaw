import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "../cron/heartbeat-monitor.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("doctor lint process artifact preservation", () => {
  it("keeps proxy, SQLite families, and managed llama preset outside the CLI process", () => {
    const rootDir = fs.realpathSync(tempDirs.make("openclaw-doctor-lint-process-"));
    const stateDir = path.join(rootDir, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config: OpenClawConfig = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        list: [{ default: true, id: "main" }],
      },
      gateway: { mode: "local" },
      memory: { search: { provider: "local", fallback: "none" } },
      // If the CLI policy regresses, proxy startup emits a pre-protocol log to
      // stderr. Lint must not initialize this network-capable global runtime.
      proxy: { enabled: true, proxyUrl: "http://127.0.0.1:9" },
    };
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const env = {
      ...process.env,
      HOME: rootDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    const heartbeatPath = path.join(resolveAgentWorkspaceDir(config, "main", env), "HEARTBEAT.md");
    fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true });
    fs.writeFileSync(heartbeatPath, "# Legacy heartbeat instructions\n");
    const identity = loadOrCreateDeviceIdentity({ env });
    const storePath = resolveCronJobsStorePathFromConfig(config, env);
    const monitorId = randomUUID();
    const { input: monitor } = expectDefined(
      resolveHeartbeatMonitorPlan(config, [], { schedulerSeed: identity.deviceId }).specs[0],
      "expected fixture heartbeat monitor",
    );
    upsertCronJobRow(
      openOpenClawStateDatabase({ env }).db,
      storePath,
      { ...monitor, id: monitorId, createdAtMs: 1, updatedAtMs: 1, state: {} },
      0,
    );
    writeCronJobScratch({
      storePath,
      jobId: monitorId,
      content: "tasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n",
      options: { env },
    });
    closeOpenClawStateDatabaseByPath(stateDatabasePath);
    const agentDatabasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabaseByPath(agentDatabasePath);

    retainClosedWalFamily(stateDatabasePath);
    retainClosedWalFamily(agentDatabasePath);
    const llamaPresetPath = path.join(stateDir, "tools", "llama.cpp", "models.ini");
    fs.mkdirSync(path.dirname(llamaPresetPath), { recursive: true });
    fs.writeFileSync(llamaPresetPath, "[embedding-only]\nmodel = fixture.gguf\n");
    const before = {
      state: snapshotSqliteFamily(stateDatabasePath),
      agent: snapshotSqliteFamily(agentDatabasePath),
      preset: snapshotFile(llamaPresetPath),
      heartbeat: snapshotFile(heartbeatPath),
    };

    const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        entryPath,
        "doctor",
        "--lint",
        "--only",
        "memory-core/managed-local-embedding-setup",
        "--only",
        "core/doctor/state-integrity",
        "--only",
        "core/doctor/legacy-state",
        "--only",
        "core/doctor/heartbeat-cadence-migration",
        "--only",
        "core/doctor/heartbeat-task-cron-migration",
        "--only",
        "core/doctor/heartbeat-scratch-migration",
        "--json",
      ],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          ALL_PROXY: undefined,
          HOME: rootDir,
          HTTP_PROXY: undefined,
          HTTPS_PROXY: undefined,
          NODE_DISABLE_COMPILE_CACHE: "1",
          NODE_ENV: undefined,
          NODE_OPTIONS: undefined,
          NO_COLOR: "1",
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_DEBUG_PROXY_ENABLED: undefined,
          OPENCLAW_DEBUG_PROXY_REQUIRE: undefined,
          OPENCLAW_HIDE_BANNER: "1",
          OPENCLAW_HOME: rootDir,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_STATE_DIR: stateDir,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          all_proxy: undefined,
          http_proxy: undefined,
          https_proxy: undefined,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 60_000,
      },
    );

    expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
    expect(result.signal).toBeNull();
    expect([0, 1]).toContain(result.status);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as {
      checksRun: number;
      findings: Array<{ checkId: string; message?: string; requirement?: string; path?: string }>;
    };
    expect(payload).toMatchObject({
      checksRun: 6,
      findings: expect.any(Array),
    });
    expect(payload.findings.map((finding) => finding.message)).not.toContain(
      "Session store dir is missing.",
    );
    expect(
      payload.findings.filter(
        (finding) => finding.checkId === "core/doctor/heartbeat-cadence-migration",
      ),
    ).toEqual([]);
    expect(payload.findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-task-cron-migration",
        requirement: "heartbeat-tasks-in-scratch",
        path: storePath,
      }),
    );
    expect(payload.findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-scratch-migration",
        requirement: "legacy-heartbeat-file",
        path: heartbeatPath,
      }),
    );
    expect(snapshotSqliteFamily(stateDatabasePath)).toEqual(before.state);
    expect(snapshotSqliteFamily(agentDatabasePath)).toEqual(before.agent);
    expect(snapshotFile(llamaPresetPath)).toEqual(before.preset);
    expect(snapshotFile(heartbeatPath)).toEqual(before.heartbeat);
  }, 90_000);
});

function retainClosedWalFamily(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA user_version;");
  const retained = ["-wal", "-shm"].map((suffix) => ({
    path: `${databasePath}${suffix}`,
    contents: fs.readFileSync(`${databasePath}${suffix}`),
  }));
  database.close();
  for (const entry of retained) {
    if (!fs.existsSync(entry.path)) {
      fs.writeFileSync(entry.path, entry.contents);
    }
  }
}

function snapshotSqliteFamily(databasePath: string): Array<ReturnType<typeof snapshotFile>> {
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map(snapshotFile);
}

function snapshotFile(filePath: string) {
  const stat = fs.lstatSync(filePath);
  return {
    path: filePath,
    dev: stat.dev,
    ino: stat.ino,
    mode: stat.mode,
    uid: stat.uid,
    gid: stat.gid,
    nlink: stat.nlink,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
  };
}
