import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { inspectSharedAuthLegacyRowsReadOnly } from "../agents/auth-profiles/shared-store-bootstrap.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorPlan } from "../cron/heartbeat-monitor.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { upsertCronJobRow } from "../cron/store/row-codec.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { withArtifactPreservingSqliteReadLocations } from "../infra/sqlite-readonly-operations.js";
import { writePersistedInstalledPluginIndexInstallRecords } from "../plugins/installed-plugin-index-records.js";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { runDoctorLintCli } from "./doctor-lint.js";

const mocks = vi.hoisted(() => ({
  actualOpenNodeSqliteDatabase: vi.fn(),
  openNodeSqliteDatabase: vi.fn(),
}));

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  mocks.actualOpenNodeSqliteDatabase.mockImplementation(actual.openNodeSqliteDatabase);
  mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) =>
    mocks.actualOpenNodeSqliteDatabase(...args),
  );
  return {
    ...actual,
    openNodeSqliteDatabase: mocks.openNodeSqliteDatabase,
  };
});

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const originalEnv = {
  HOME: process.env.HOME,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
};

describe("doctor lint artifact preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHealthChecksForTest();
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) =>
      mocks.actualOpenNodeSqliteDatabase(...args),
    );
  });

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("inspects legacy shared auth rows through the private snapshot", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-shared-auth-snapshot-"));
    const sourcePath = path.join(rootDir, "openclaw-agent.sqlite");
    const sourceDatabase = new DatabaseSync(sourcePath);
    sourceDatabase.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_profile_state (
        state_key TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO auth_profile_store VALUES ('primary', '{"profiles":{}}', 11);
      INSERT INTO auth_profile_state VALUES ('primary', '{"lastGood":{}}', 12);
    `);
    sourceDatabase.close();
    const before = snapshotSqliteFamily(sourcePath);
    const openedPaths: string[] = [];
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
      openedPaths.push(String(args[0]));
      return mocks.actualOpenNodeSqliteDatabase(...args);
    });

    try {
      const rows = await withArtifactPreservingSqliteReadLocations(async () =>
        inspectSharedAuthLegacyRowsReadOnly(sourcePath),
      );
      expect(rows).toEqual({
        store: { store_json: '{"profiles":{}}', updated_at: 11 },
        state: { state_json: '{"lastGood":{}}', updated_at: 12 },
      });
      expect(openedPaths).toHaveLength(1);
      expect(openedPaths[0]).not.toBe(sourcePath);
      expect(snapshotSqliteFamily(sourcePath)).toEqual(before);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("runs the full registry without opening or changing the source state database", async () => {
    const rootDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-all-state-")),
    );
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      agents: {
        defaults: { heartbeat: { every: "1h" } },
        list: [{ default: true, id: "main" }],
      },
      gateway: { mode: "local" },
      memory: { search: { provider: "local", fallback: "none" } },
    } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const llamaPresetPath = path.join(stateDir, "tools", "llama.cpp", "models.ini");
    fs.mkdirSync(path.dirname(llamaPresetPath), { recursive: true });
    fs.writeFileSync(llamaPresetPath, "[embedding-only]\nmodel = fixture.gguf\n");
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const databasePath = resolveOpenClawStateSqlitePath(env);
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
    closeOpenClawStateDatabaseByPath(databasePath);
    const agentDatabasePath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
    closeOpenClawAgentDatabaseByPath(agentDatabasePath);
    closeOpenClawStateDatabaseByPath(databasePath);

    const sourceDatabase = new DatabaseSync(databasePath);
    sourceDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    sourceDatabase.exec("PRAGMA user_version;");
    const sourceAgentDatabase = new DatabaseSync(agentDatabasePath);
    sourceAgentDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    sourceAgentDatabase.exec("PRAGMA user_version;");
    const before = snapshotSqliteFamily(databasePath);
    const agentBefore = snapshotSqliteFamily(agentDatabasePath);
    const llamaPresetBefore = snapshotFile(llamaPresetPath);
    const heartbeatBefore = snapshotFile(heartbeatPath);
    const sourceOpenStacks: string[] = [];
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
      if (args[0] === databasePath || args[0] === agentDatabasePath) {
        sourceOpenStacks.push(new Error("source database opened").stack ?? "");
      }
      return mocks.actualOpenNodeSqliteDatabase(...args);
    });
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runDoctorLintCli(runtime, { json: true, includeAllChecks: true });
      const report = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as {
        findings: Array<{ checkId: string; requirement?: string; path?: string }>;
      };
      expect(
        report.findings.filter(
          (finding) => finding.checkId === "core/doctor/heartbeat-cadence-migration",
        ),
      ).toEqual([]);
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/heartbeat-task-cron-migration",
          requirement: "heartbeat-tasks-in-scratch",
          path: storePath,
        }),
      );
      expect(report.findings).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/heartbeat-scratch-migration",
          requirement: "legacy-heartbeat-file",
          path: heartbeatPath,
        }),
      );
      expect(sourceOpenStacks).toEqual([]);
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
      expect(snapshotSqliteFamily(agentDatabasePath)).toEqual(agentBefore);
      expect(snapshotFile(llamaPresetPath)).toEqual(llamaPresetBefore);
      expect(snapshotFile(heartbeatPath)).toEqual(heartbeatBefore);
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(true);
      expect(fs.existsSync(`${agentDatabasePath}-shm`)).toBe(true);
    } finally {
      stdout.mockRestore();
      sourceAgentDatabase.close();
      sourceDatabase.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  }, 300_000);

  it("keeps mixed selected checks on a fully isolated state view", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-private-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      gateway: { mode: "local" },
      agents: { defaults: { workspace: "${OPENCLAW_STATE_DIR}/workspace" } },
      memory: { search: { provider: "local", fallback: "none" } },
    } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, "agents", "main", "sessions"), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    await writePersistedInstalledPluginIndexInstallRecords(
      {},
      { config, env, stateDir, workspaceDir: rootDir },
    );
    const databasePath = resolveOpenClawStateSqlitePath(env);
    closeOpenClawStateDatabaseByPath(databasePath);
    const before = snapshotSqliteFamily(databasePath);
    mocks.openNodeSqliteDatabase.mockClear();
    const sourceOpenStacks: string[] = [];
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
      if (args[0] === databasePath) {
        sourceOpenStacks.push(new Error("source database opened").stack ?? "");
      }
      return mocks.actualOpenNodeSqliteDatabase(...args);
    });
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const inspectSourceConfig = vi.fn(async (ctx: { cfg: OpenClawConfig }) => {
      expect(ctx.cfg.agents?.defaults?.workspace).toBe(path.join(stateDir, "workspace"));
      return [];
    });
    registerHealthCheck({
      id: "test/source-config-interpolation",
      kind: "plugin",
      description: "checks source-path interpolation",
      detect: inspectSourceConfig,
    });

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
          onlyIds: [
            "memory-core/managed-local-embedding-setup",
            "core/doctor/state-integrity",
            "test/source-config-interpolation",
          ],
        }),
      ).resolves.toBe(0);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: true,
        checksRun: 3,
        findings: [],
      });
      expect(inspectSourceConfig).toHaveBeenCalledOnce();
      expect(sourceOpenStacks).toEqual([]);
      expect(snapshotSqliteFamily(databasePath)).toEqual(before);
    } finally {
      stdout.mockRestore();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("inspects legacy state without opening the source or changing durable SQLite bytes", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-legacy-state-"));
    const stateDir = path.join(rootDir, "operator-state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = { gateway: { mode: "local" } } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const env = {
      ...process.env,
      HOME: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
    };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    const stateDatabase = openOpenClawStateDatabase({ env }).db;
    stateDatabase
      .prepare(
        `INSERT INTO worktrees (
           id, repo_fingerprint, repo_root, path, branch, base_ref, owner_kind,
           owner_id, snapshot_ref, created_at, last_active_at, removed_at,
           provisioned_paths_json, run_end_cleanup_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        "legacy-worktree",
        "0123456789abcdef",
        path.join(rootDir, "repo"),
        path.join(rootDir, "worktrees", "legacy"),
        "openclaw/legacy",
        "HEAD",
        "workboard",
        1,
        1,
      );
    closeOpenClawStateDatabaseByPath(databasePath);

    const sourceDatabase = new DatabaseSync(databasePath);
    sourceDatabase.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
    sourceDatabase.exec(
      "UPDATE worktrees SET last_active_at = last_active_at + 1 WHERE id = 'legacy-worktree'",
    );
    const before = snapshotSqliteFamily(databasePath);
    expect(before.map((entry) => path.basename(entry.path))).toEqual(
      expect.arrayContaining([
        path.basename(databasePath),
        `${path.basename(databasePath)}-shm`,
        `${path.basename(databasePath)}-wal`,
      ]),
    );

    mocks.openNodeSqliteDatabase.mockClear();
    const sourceOpenStacks: string[] = [];
    mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
      if (args[0] === databasePath) {
        sourceOpenStacks.push(new Error("source database opened").stack ?? "");
      }
      return mocks.actualOpenNodeSqliteDatabase(...args);
    });
    process.env.HOME = stateDir;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          onlyIds: ["core/doctor/legacy-state"],
        }),
      ).resolves.toBe(1);
      expect(JSON.parse(String(stdout.mock.calls.at(-1)?.[0]))).toMatchObject({
        ok: false,
        checksRun: 1,
        findings: expect.arrayContaining([
          expect.objectContaining({
            checkId: "core/doctor/legacy-state",
            severity: "warning",
          }),
        ]),
      });
      expect(sourceOpenStacks).toEqual([]);
      expect(
        snapshotSqliteFamily(databasePath).filter((entry) => !entry.path.endsWith("-shm")),
      ).toEqual(before.filter((entry) => !entry.path.endsWith("-shm")));
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(true);
    } finally {
      stdout.mockRestore();
      sourceDatabase.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

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

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
