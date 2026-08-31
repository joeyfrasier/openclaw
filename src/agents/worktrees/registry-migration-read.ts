import type { DatabaseSync } from "node:sqlite";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";

export function withRegistryMigrationRead<T>(
  env: NodeJS.ProcessEnv,
  fallback: T,
  read: (db: DatabaseSync) => T,
): T {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => (tableExists(db, "worktrees") ? read(db) : fallback),
      { env },
    ) ?? fallback
  );
}
