import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  refreshModelRuntimeAfterHotReload,
  resolveReloadAgentIds,
} from "./server-reload-model-runtime-scope.js";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(async () => {}),
  selections: vi.fn(),
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  refreshPreparedModelRuntimeSnapshots: mocks.refresh,
}));
vi.mock("./server-startup-model-runtime-selections.js", () => ({
  readGatewayPersistedRuntimePluginSelections: mocks.selections,
}));

describe("prepared model runtime reload scope", () => {
  beforeEach(() => {
    mocks.refresh.mockClear();
    mocks.selections.mockReset();
  });

  it("retains locked runtime selections alongside agent scope and publication cancellation", async () => {
    const config = {} as OpenClawConfig;
    const agentIds = new Set(["main"]);
    const pluginMetadataSnapshot = {} as PluginMetadataSnapshot;
    const isPublicationCurrent = () => true;
    const selections = new Map([
      ["main", [{ modelId: "gpt-5.5", provider: "openai", runtime: "codex" }]],
    ]);
    mocks.selections.mockReturnValue(selections);

    await refreshModelRuntimeAfterHotReload({
      config,
      agentIds,
      pluginMetadataSnapshot,
      isPublicationCurrent,
    });

    expect(mocks.selections).toHaveBeenCalledExactlyOnceWith(config);
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(config, {
      additionalRuntimePluginSelectionsByAgentId: selections,
      agentIds,
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      isPublicationCurrent,
      pluginMetadataSnapshot,
    });
  });

  it("does not begin publication after an incomplete persisted selection scan", () => {
    const error = new Error("persisted selection scan blocked");
    mocks.selections.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      refreshModelRuntimeAfterHotReload({
        config: {},
        agentIds: undefined,
        pluginMetadataSnapshot: undefined,
      }),
    ).toThrow(error);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("collects normalized agent ids from agent-entry-local paths", () => {
    expect(
      resolveReloadAgentIds(["agents.entries.Alpha.model", "agents.entries.beta.name"]),
    ).toEqual(new Set(["alpha", "beta"]));
  });

  it("ignores machine-managed metadata beside an agent-local path", () => {
    expect(resolveReloadAgentIds(["agents.entries.alpha.model", "meta.lastTouchedAt"])).toEqual(
      new Set(["alpha"]),
    );
  });

  it.each([
    [[]],
    [["agents.entries"]],
    [["agents.entries.alpha.model", "models.providers.openai.api"]],
  ])("falls back to full refresh for an unbounded path set: %j", (paths) => {
    expect(resolveReloadAgentIds(paths)).toBeUndefined();
  });
});
