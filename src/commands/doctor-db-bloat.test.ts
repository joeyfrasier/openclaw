import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withArtifactPreservingOpenClawStateDatabaseReads } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { noteSqliteDatabaseBloat } from "./doctor-db-bloat.js";

const mocks = vi.hoisted(() => ({
  locations: [] as string[],
}));

vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  return {
    ...actual,
    openNodeSqliteDatabase(
      location: string,
      options?: Parameters<typeof actual.openNodeSqliteDatabase>[1],
    ) {
      mocks.locations.push(location);
      return actual.openNodeSqliteDatabase(location, options);
    },
  };
});

const roots: string[] = [];

function sqliteFamily(databasePath: string): Array<{ path: string; sha256: string }> {
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    }));
}

afterEach(() => {
  mocks.locations.length = 0;
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("noteSqliteDatabaseBloat", () => {
  it("inspects WAL state through private snapshots without opening the source", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-db-bloat-"));
    roots.push(root);
    const env = { ...process.env, OPENCLAW_STATE_DIR: root };
    const databasePath = resolveOpenClawStateSqlitePath(env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const writer = new DatabaseSync(databasePath);
    try {
      writer.exec(
        "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe DEFAULT VALUES;",
      );
      const before = sqliteFamily(databasePath);
      mocks.locations.length = 0;

      await withArtifactPreservingOpenClawStateDatabaseReads(async () => {
        noteSqliteDatabaseBloat({}, { env });
      });

      expect(mocks.locations).not.toContain(databasePath);
      expect(
        mocks.locations.some((location) => path.basename(location) === "database.sqlite"),
      ).toBe(true);
      expect(sqliteFamily(databasePath)).toEqual(before);
    } finally {
      writer.close();
    }
  });
});
