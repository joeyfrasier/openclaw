// Higher-level read-only SQLite operations built on private stable snapshots.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { hasErrnoCode } from "./errno.js";
import {
  prepareSqliteReadOnlyLocation,
  prepareSqliteReadOnlyLocationSync,
} from "./sqlite-readonly-location.js";

type PreparedSqliteReadOnlyLocation = ReturnType<typeof prepareSqliteReadOnlyLocationSync>;

const artifactPreservingReadLocations = new AsyncLocalStorage<
  Map<string, PreparedSqliteReadOnlyLocation>
>();

/** Reuse one private snapshot per source database for a complete diagnostic run. */
export async function withArtifactPreservingSqliteReadLocations<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (artifactPreservingReadLocations.getStore()) {
    return await operation();
  }

  const preparedBySource = new Map<string, PreparedSqliteReadOnlyLocation>();
  let outcome: { ok: true; value: T } | { error: unknown; ok: false };
  try {
    outcome = {
      ok: true,
      value: await artifactPreservingReadLocations.run(preparedBySource, operation),
    };
  } catch (error) {
    outcome = { error, ok: false };
  }

  const cleanupErrors: unknown[] = [];
  for (const prepared of preparedBySource.values()) {
    try {
      if (!prepared.cleanup()) {
        cleanupErrors.push(new Error("SQLite read-only snapshot cleanup did not complete."));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!outcome.ok) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [outcome.error, ...cleanupErrors],
        "SQLite diagnostic and snapshot cleanup both failed",
      );
    }
    throw outcome.error;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "SQLite read-only snapshot cleanup failed");
  }
  return outcome.value;
}

/** Redirect a read to the diagnostic scope's stable private snapshot when one is active. */
export function withArtifactPreservingSqliteReadLocationSync<T>(
  pathname: string,
  operation: (location: string) => T,
): T {
  const preparedBySource = artifactPreservingReadLocations.getStore();
  if (!preparedBySource) {
    return operation(pathname);
  }
  const canonicalPath = fs.realpathSync.native(pathname);
  let prepared = preparedBySource.get(canonicalPath);
  if (!prepared) {
    prepared = prepareSqliteReadOnlyLocationSync(canonicalPath);
    preparedBySource.set(canonicalPath, prepared);
  }
  return operation(prepared.location);
}

/** True only while a caller owns a diagnostic private-snapshot epoch. */
export function isArtifactPreservingSqliteReadLocationsActive(): boolean {
  return artifactPreservingReadLocations.getStore() !== undefined;
}

async function prepareSqliteSnapshotSource(
  pathname: string,
): Promise<Awaited<ReturnType<typeof prepareSqliteReadOnlyLocation>> | undefined> {
  const canonicalPath = fs.realpathSync.native(pathname);
  const journalPath = `${canonicalPath}-journal`;
  let journal: fs.BigIntStats;
  try {
    journal = fs.lstatSync(journalPath, { bigint: true });
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (!journal.isFile()) {
    throw new Error(`SQLite rollback journal must be a regular file: ${journalPath}`);
  }
  return await prepareSqliteReadOnlyLocation(canonicalPath);
}

export async function withSqliteSnapshotSource<T>(
  pathname: string,
  operation: (sourcePath: string) => Promise<T>,
): Promise<T> {
  let prepared = await prepareSqliteSnapshotSource(pathname);
  try {
    try {
      return await operation(prepared?.location ?? pathname);
    } catch (error) {
      if (prepared) {
        throw error;
      }
      prepared = await prepareSqliteSnapshotSource(pathname);
      if (!prepared) {
        throw error;
      }
      return await operation(prepared.location);
    }
  } finally {
    prepared?.cleanup();
  }
}
