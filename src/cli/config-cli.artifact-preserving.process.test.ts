import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("config dry-run process artifact preservation", () => {
  it("does not mutate config or create shared-state SQLite sidecars", () => {
    const rootDir = tempDirs.make("openclaw-config-dry-run-process-");
    const stateDir = path.join(rootDir, "state");
    const cacheDir = path.join(rootDir, "cache");
    const configPath = path.join(stateDir, "openclaw.json");
    const patchPath = path.join(rootDir, "patch.json5");
    const config = {
      agents: { list: [{ default: true, id: "main" }] },
      gateway: { mode: "local" },
      proxy: { enabled: true, proxyUrl: "http://127.0.0.1:9" },
    } satisfies OpenClawConfig;
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    fs.writeFileSync(patchPath, "{ gateway: { port: 19000 } }\n");
    const env = {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_HOME: rootDir,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CACHE_HOME: cacheDir,
    };
    const stateDatabasePath = resolveOpenClawStateSqlitePath(env);
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseByPath(stateDatabasePath);
    for (const suffix of ["-journal", "-shm", "-wal"]) {
      fs.rmSync(`${stateDatabasePath}${suffix}`, { force: true });
    }
    const before = {
      config: snapshotFile(configPath),
      patch: snapshotFile(patchPath),
      state: snapshotSqliteFamily(stateDatabasePath),
    };

    const entryPath = fileURLToPath(new URL("../entry.ts", import.meta.url));
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", entryPath, "config", "patch", "--file", patchPath, "--dry-run", "--json"],
      {
        cwd: path.resolve("."),
        encoding: "utf8",
        env: {
          ...process.env,
          ALL_PROXY: undefined,
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
          XDG_CACHE_HOME: cacheDir,
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
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      operations: 1,
      inputModes: ["json"],
      checks: { schema: true },
    });
    expect(snapshotFile(configPath)).toEqual(before.config);
    expect(snapshotFile(patchPath)).toEqual(before.patch);
    expect(snapshotSqliteFamily(stateDatabasePath)).toEqual(before.state);
  }, 90_000);
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
