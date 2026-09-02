import { listAgentIds } from "../agents/agent-scope-config.js";
import type { AgentHarnessPluginSelection } from "../agents/harness/runtime-plugin-load-plan.js";
import {
  readPersistedLockedRuntimeSelectionsReadOnly,
  type PersistedLockedRuntimeSelection,
} from "../config/sessions/session-accessor.js";
import {
  dedupeSessionStoreTargetsBySqliteTarget,
  resolveAgentSessionStoreTargetsSync,
  resolveSessionStoreCompatibilityAgentId,
} from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveSessionStoreAgentId } from "./session-store-key.js";

function toPluginSelection(
  selection: PersistedLockedRuntimeSelection,
): AgentHarnessPluginSelection {
  return {
    modelId: selection.modelId,
    provider: selection.provider,
    runtime: selection.runtime,
  };
}

/**
 * Resolves locked session-owned runtime selections before configured model runtimes publish.
 * A corrupt or incomplete store scan aborts the whole publication instead of activating a
 * trustworthy-looking subset of external harnesses.
 */
export function readGatewayPersistedRuntimePluginSelections(
  cfg: OpenClawConfig,
): ReadonlyMap<string, readonly AgentHarnessPluginSelection[]> {
  const configuredAgentIds = new Set(listAgentIds(cfg).map((agentId) => normalizeAgentId(agentId)));
  const selectionsByAgentId = new Map<string, Map<string, AgentHarnessPluginSelection>>();
  const targets = dedupeSessionStoreTargetsBySqliteTarget(
    [...configuredAgentIds].flatMap((agentId) => resolveAgentSessionStoreTargetsSync(cfg, agentId)),
    { defaultAgentId: resolveSessionStoreCompatibilityAgentId(cfg) },
  );
  for (const target of targets) {
    const result = readPersistedLockedRuntimeSelectionsReadOnly(
      {
        agentId: target.agentId,
        storePath: target.storePath,
      },
      { configuredAgentIds },
    );
    if (result.status === "blocked") {
      throw new Error(
        `persisted locked runtime selection scan blocked for agent ${target.agentId}: ${result.reason}`,
      );
    }
    for (const fact of result.selections) {
      const agentId = normalizeAgentId(resolveSessionStoreAgentId(cfg, fact.sessionKey));
      if (!configuredAgentIds.has(agentId)) {
        continue;
      }
      const selection = toPluginSelection(fact);
      const agentSelections = selectionsByAgentId.get(agentId) ?? new Map();
      agentSelections.set(JSON.stringify(selection), selection);
      selectionsByAgentId.set(agentId, agentSelections);
    }
  }
  return new Map(
    [...selectionsByAgentId].map(([agentId, selections]) => [agentId, [...selections.values()]]),
  );
}
