import fs from "node:fs";
import path from "node:path";

const SQLITE_SNAPSHOT_STAGING_PREFIX = "openclaw-sqlite-readonly-";
const SQLITE_SNAPSHOT_DIRECTORY_PATTERN =
  /^openclaw-sqlite-readonly-([1-9][0-9]*)-[A-Za-z0-9_-]+$/u;
const SQLITE_SNAPSHOT_FILE_PATHS = new Set([
  "database.sqlite",
  "database.sqlite-journal",
  "database.sqlite-shm",
  "database.sqlite-wal",
  "first",
  "second",
  "openclaw-state/state/openclaw.sqlite",
  "openclaw-state/state/openclaw.sqlite-journal",
  "openclaw-state/state/openclaw.sqlite-shm",
  "openclaw-state/state/openclaw.sqlite-wal",
]);
const SQLITE_SNAPSHOT_DIRECTORY_PATHS = new Set(["openclaw-state", "openclaw-state/state"]);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // SAFETY: Node process probes report liveness failures through errno-shaped errors.
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    // EPERM or an unknown process-probe failure is not deletion authority.
    return true;
  }
}

function assertPrivateStaleSnapshotDirectory(directoryPath: string): void {
  const directory = fs.lstatSync(directoryPath);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (process.platform !== "win32" &&
      (currentUid === undefined || directory.uid !== currentUid || (directory.mode & 0o077) !== 0))
  ) {
    throw new Error(`Unsafe stale SQLite snapshot directory: ${directoryPath}`);
  }
  const pending = [{ absolute: directoryPath, relative: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }
    for (const name of fs.readdirSync(current.absolute).toSorted()) {
      const memberPath = path.join(current.absolute, name);
      const relativePath = current.relative ? `${current.relative}/${name}` : name;
      const member = fs.lstatSync(memberPath);
      const privateOwner =
        process.platform === "win32" ||
        (currentUid !== undefined && member.uid === currentUid && (member.mode & 0o077) === 0);
      if (
        member.isSymbolicLink() ||
        !privateOwner ||
        (!member.isFile() && !member.isDirectory()) ||
        (member.isFile() && !SQLITE_SNAPSHOT_FILE_PATHS.has(relativePath)) ||
        (member.isDirectory() && !SQLITE_SNAPSHOT_DIRECTORY_PATHS.has(relativePath))
      ) {
        throw new Error(`Unsafe stale SQLite snapshot member: ${memberPath}`);
      }
      if (member.isDirectory()) {
        pending.push({ absolute: memberPath, relative: relativePath });
      }
    }
  }
}

/** Remove only owner-private snapshot directories whose exact process owner is gone. */
export function reclaimStalePrivateSqliteSnapshotsSync(stagingRoot: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(stagingRoot);
  } catch (error) {
    // SAFETY: Node filesystem failures carry the stable errno code used below.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let reclaimed = 0;
  for (const name of names.toSorted()) {
    const match = SQLITE_SNAPSHOT_DIRECTORY_PATTERN.exec(name);
    if (!match) {
      continue;
    }
    const ownerPid = Number(match[1]);
    if (!Number.isSafeInteger(ownerPid) || isProcessAlive(ownerPid)) {
      continue;
    }
    const directoryPath = path.join(stagingRoot, name);
    assertPrivateStaleSnapshotDirectory(directoryPath);
    fs.rmSync(directoryPath, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
    reclaimed += 1;
  }
  return reclaimed;
}

export function sqliteSnapshotStagingPrefix(ownerPid: number): string {
  if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
    throw new Error("SQLite snapshot owner PID must be a positive safe integer.");
  }
  return `${SQLITE_SNAPSHOT_STAGING_PREFIX}${ownerPid}-`;
}
