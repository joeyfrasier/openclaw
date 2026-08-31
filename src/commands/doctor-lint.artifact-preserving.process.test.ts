import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
    const rootDir = tempDirs.make("openclaw-doctor-lint-process-");
    const stateDir = path.join(rootDir, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const config = {
      agents: { list: [{ default: true, id: "main" }] },
      gateway: { mode: "local" },
      memory: { search: { provider: "local", fallback: "none" } },
      // If the CLI policy regresses, proxy startup emits a pre-protocol log to
      // stderr. Lint must not initialize this network-capable global runtime.
      proxy: { enabled: true, proxyUrl: "http://127.0.0.1:9" },
    } satisfies OpenClawConfig;
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
    openOpenClawStateDatabase({ env });
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
      findings: Array<{ message?: string }>;
    };
    expect(payload).toMatchObject({
      checksRun: 3,
      findings: expect.any(Array),
    });
    expect(payload.findings.map((finding) => finding.message)).not.toContain(
      "Session store dir is missing.",
    );
    expect(snapshotSqliteFamily(stateDatabasePath)).toEqual(before.state);
    expect(snapshotSqliteFamily(agentDatabasePath)).toEqual(before.agent);
    expect(snapshotFile(llamaPresetPath)).toEqual(before.preset);
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
