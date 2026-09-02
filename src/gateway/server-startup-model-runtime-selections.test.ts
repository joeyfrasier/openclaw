import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  configuredAgentIds: ["main"],
  readSelections: vi.fn(),
  resolveAgentId: vi.fn((_: unknown, sessionKey: string) => sessionKey.split(":")[1] ?? "main"),
  resolveTargets: vi.fn((_: unknown, agentId: string) => [
    { agentId, storePath: `/tmp/${agentId}-sessions.json` },
  ]),
}));

vi.mock("../agents/agent-scope-config.js", () => ({
  listAgentIds: () => mocks.configuredAgentIds,
}));
vi.mock("../config/sessions/session-accessor.js", () => ({
  readPersistedLockedRuntimeSelectionsReadOnly: mocks.readSelections,
}));
vi.mock("../config/sessions/targets.js", () => ({
  dedupeSessionStoreTargetsBySqliteTarget: (targets: unknown) => targets,
  resolveAgentSessionStoreTargetsSync: mocks.resolveTargets,
  resolveSessionStoreCompatibilityAgentId: () => "main",
}));
vi.mock("./session-store-key.js", () => ({
  resolveSessionStoreAgentId: mocks.resolveAgentId,
}));

import { readGatewayPersistedRuntimePluginSelections } from "./server-startup-model-runtime-selections.js";

describe("gateway persisted runtime plugin selections", () => {
  beforeEach(() => {
    mocks.configuredAgentIds = ["main"];
    mocks.readSelections.mockReset();
    mocks.resolveAgentId.mockClear();
    mocks.resolveTargets.mockClear();
  });

  it("groups and deduplicates complete locked-session selections by configured agent", () => {
    mocks.readSelections.mockReturnValue({
      status: "complete",
      selections: [
        {
          modelId: "gpt-5.5",
          provider: "openai",
          runtime: "codex",
          sessionKey: "agent:main:one",
        },
        {
          modelId: "gpt-5.5",
          provider: "openai",
          runtime: "codex",
          sessionKey: "agent:main:two",
        },
      ],
    });

    expect(readGatewayPersistedRuntimePluginSelections({})).toEqual(
      new Map([["main", [{ modelId: "gpt-5.5", provider: "openai", runtime: "codex" }]]]),
    );
  });

  it("fails the whole startup selection read instead of returning a partial external owner", () => {
    mocks.configuredAgentIds = ["main", "worker"];
    mocks.readSelections
      .mockReturnValueOnce({
        status: "complete",
        selections: [
          {
            modelId: "gpt-5.5",
            provider: "openai",
            runtime: "codex",
            sessionKey: "agent:main:one",
          },
        ],
      })
      .mockReturnValueOnce({ status: "blocked", reason: "row-limit", selections: [] });

    expect(() => readGatewayPersistedRuntimePluginSelections({})).toThrow(
      "persisted locked runtime selection scan blocked for agent worker: row-limit",
    );
  });

  it("does not publish selections owned by an unconfigured agent", () => {
    mocks.readSelections.mockReturnValue({
      status: "complete",
      selections: [
        {
          modelId: "external-model",
          provider: "external-provider",
          runtime: "external-runtime",
          sessionKey: "agent:retired:one",
        },
      ],
    });

    expect(readGatewayPersistedRuntimePluginSelections({})).toEqual(new Map());
    expect(mocks.resolveTargets).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTargets).toHaveBeenCalledWith({}, "main");
    expect(mocks.readSelections).toHaveBeenCalledWith(
      { agentId: "main", storePath: "/tmp/main-sessions.json" },
      { configuredAgentIds: new Set(["main"]) },
    );
  });
});
