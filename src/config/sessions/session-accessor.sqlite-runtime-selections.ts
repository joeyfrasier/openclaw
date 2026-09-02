import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sql } from "kysely";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  getSessionKysely,
  resolveSqliteScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { parseSessionEntryJson } from "./session-accessor.sqlite-status.js";
import type { SessionEntryListScope } from "./session-accessor.types.js";

export const MAX_PERSISTED_LOCKED_RUNTIME_SELECTION_ROWS = 2_000;
export const MAX_PERSISTED_RUNTIME_SELECTION_INSPECTED_ROWS = 10_000;

export type PersistedLockedRuntimeSelection = Readonly<{
  modelId: string;
  provider: string;
  runtime: string;
  sessionKey: string;
}>;

export type PersistedLockedRuntimeSelectionReadResult =
  | Readonly<{
      status: "complete";
      selections: readonly PersistedLockedRuntimeSelection[];
    }>
  | Readonly<{
      status: "blocked";
      reason: "invalid-entry" | "row-limit" | "scan-limit" | "schema-missing" | "table-missing";
      selections: readonly [];
    }>;

function normalizeRuntimeId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "pi") {
    return "openclaw";
  }
  if (normalized === "codex-app-server") {
    return "codex";
  }
  return normalized;
}

function blocked(
  reason: Extract<PersistedLockedRuntimeSelectionReadResult, { status: "blocked" }>["reason"],
): PersistedLockedRuntimeSelectionReadResult {
  return { status: "blocked", reason, selections: [] };
}

/**
 * Reads the bounded current-session facts that may require a non-default harness at startup.
 * Any malformed locked owner or incomplete scan rejects the whole result so partial state can
 * never silently activate an external runtime.
 */
export function readPersistedLockedRuntimeSelectionsReadOnly(
  scope: SessionEntryListScope,
  options: { maxInspectedRows?: number; maxRows?: number } = {},
): PersistedLockedRuntimeSelectionReadResult {
  const maxRows = options.maxRows ?? MAX_PERSISTED_LOCKED_RUNTIME_SELECTION_ROWS;
  const maxInspectedRows =
    options.maxInspectedRows ?? MAX_PERSISTED_RUNTIME_SELECTION_INSPECTED_ROWS;
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
    throw new Error("persisted locked runtime selection maxRows must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxInspectedRows) || maxInspectedRows < 1) {
    throw new Error(
      "persisted locked runtime selection maxInspectedRows must be a positive safe integer",
    );
  }
  const resolved = resolveSqliteScope({ ...scope, sessionKey: "" });
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const db = getSessionKysely(database.db);
    return executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("session_nodes")
        .leftJoin("session_windows as current_window", (join) =>
          join
            .onRef("current_window.session_id", "=", "session_nodes.current_session_id")
            .onRef("current_window.session_key", "=", "session_nodes.session_key"),
        )
        .select([
          "session_nodes.current_session_id",
          "session_nodes.entry_json",
          "session_nodes.entry_valid",
          "session_nodes.session_key",
          "session_nodes.updated_at",
          "current_window.agent_harness_id as current_agent_harness_id",
          "current_window.model as current_model",
          "current_window.model_provider as current_model_provider",
          "current_window.session_id as retained_window_id",
        ])
        // Bound only rows that can affect runtime activation. Ordinary unlocked,
        // valid session history must not make Gateway startup depend on total
        // retention volume. Invalid projected rows remain candidates so the read
        // still fails closed instead of hiding malformed external ownership.
        .where(
          sql<boolean>`(
            session_nodes.entry_valid <> 1
            AND current_window.agent_harness_id IS NOT NULL
          ) OR CASE
            WHEN json_valid(session_nodes.entry_json)
              THEN json_extract(session_nodes.entry_json, '$.modelSelectionLocked') = 1
            ELSE current_window.agent_harness_id IS NOT NULL
          END`,
        )
        .orderBy("session_nodes.session_key", "asc")
        .limit(maxInspectedRows + 1),
    ).rows;
  }, toDatabaseOptions(resolved));
  if (!result.found) {
    return result.reason === "database-missing"
      ? { status: "complete", selections: [] }
      : blocked(result.reason);
  }
  if (result.value.length > maxInspectedRows) {
    return blocked("scan-limit");
  }

  const selections = new Map<string, PersistedLockedRuntimeSelection>();
  for (const row of result.value) {
    const projectedRuntime = normalizeRuntimeId(row.current_agent_harness_id);
    const retainedTombstone =
      row.entry_valid === -1 &&
      row.entry_json === "{}" &&
      row.retained_window_id === row.current_session_id;
    if (retainedTombstone) {
      continue;
    }
    if (row.entry_valid !== 1) {
      // A malformed unrelated row cannot activate an external runtime when
      // the retained current-window projection has no harness owner. Startup
      // must still fail closed when a projected runtime row is malformed.
      if (!projectedRuntime) {
        continue;
      }
      return blocked("invalid-entry");
    }
    const entry = parseSessionEntryJson(row);
    if (!entry) {
      if (!projectedRuntime) {
        continue;
      }
      return blocked("invalid-entry");
    }
    if (entry.modelSelectionLocked !== true) {
      continue;
    }
    const runtime = normalizeRuntimeId(entry.agentHarnessId);
    if (!runtime && !projectedRuntime) {
      // Model locking predates harness ownership. Those rows do not activate a runtime.
      continue;
    }
    const provider = normalizeOptionalString(entry.modelProvider)?.toLowerCase();
    const modelId = normalizeOptionalString(entry.model);
    const projectedProvider = normalizeOptionalString(row.current_model_provider)?.toLowerCase();
    const projectedModelId = normalizeOptionalString(row.current_model);
    if (
      !runtime ||
      !provider ||
      !modelId ||
      runtime !== projectedRuntime ||
      provider !== projectedProvider ||
      modelId !== projectedModelId
    ) {
      return blocked("invalid-entry");
    }
    // The built-in runtime never activates a plugin, so it cannot consume the
    // external-selection budget. Bound distinct external selections per owning
    // agent, matching the startup caller's eventual deduplication semantics.
    if (runtime === "openclaw") {
      continue;
    }
    const selection = { modelId, provider, runtime, sessionKey: row.session_key } as const;
    const owner = parseAgentSessionKey(row.session_key)?.agentId ?? "";
    selections.set(JSON.stringify({ owner, modelId, provider, runtime }), selection);
    if (selections.size > maxRows) {
      return blocked("row-limit");
    }
  }
  return { status: "complete", selections: [...selections.values()] };
}
