/**
 * Gateway startup orchestration tests.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const prepareModelRuntimeSnapshotMock = vi.fn(async (_params: unknown) => ({}));
const persistedRuntimeSelections = new Map([
  ["default", [{ modelId: "gpt-5.5", provider: "openai", runtime: "codex" }]],
]);
const readPersistedRuntimeSelectionsMock = vi.fn(
  (_cfg: OpenClawConfig) => persistedRuntimeSelections,
);
type RuntimeConfigSource = OpenClawConfig | (() => OpenClawConfig | Promise<OpenClawConfig>);
const refreshPreparedModelRuntimeSnapshotsMock = vi.fn(
  async (
    _cfg: RuntimeConfigSource,
    _options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
      additionalRuntimePluginSelectionsByAgentId?: ReadonlyMap<string, readonly unknown[]>;
    },
  ) => {},
);

vi.mock("../agents/agent-scope.js", () => ({
  resolveDefaultAgentDir: () => "/tmp/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace",
  resolveDefaultAgentId: () => "default",
}));

vi.mock("../agents/prepared-model-runtime.js", () => ({
  publishPreparedModelRuntimeSnapshot: (params: unknown) => prepareModelRuntimeSnapshotMock(params),
  refreshPreparedModelRuntimeSnapshots: (
    cfg: RuntimeConfigSource,
    options?: {
      gatewayLifecycle?: boolean;
      defaultWorkspaceDir?: string;
      catalogMode?: "live" | "static";
      allowGatewaySubagentBinding?: boolean;
      isPublicationCurrent?: () => boolean;
      additionalRuntimePluginSelectionsByAgentId?: ReadonlyMap<string, readonly unknown[]>;
    },
  ) => refreshPreparedModelRuntimeSnapshotsMock(cfg, options),
}));

vi.mock("./server-startup-model-runtime-selections.js", () => ({
  readGatewayPersistedRuntimePluginSelections: (cfg: OpenClawConfig) =>
    readPersistedRuntimeSelectionsMock(cfg),
}));

let prewarmConfiguredPrimaryModel: typeof import("./server-startup-post-attach.js").testing.prewarmConfiguredPrimaryModel;
let hydrateConfiguredExternalCliAuth: typeof import("./server-startup-post-attach.js").testing.hydrateConfiguredExternalCliAuth;
let publishStartupModelRuntime: typeof import("./server-startup-post-attach.js").testing.publishStartupModelRuntime;
let shouldSkipStartupModelPrewarm: typeof import("./server-startup-post-attach.js").testing.shouldSkipStartupModelPrewarm;

describe("gateway startup primary model warmup", () => {
  beforeAll(async () => {
    ({
      testing: {
        prewarmConfiguredPrimaryModel,
        hydrateConfiguredExternalCliAuth,
        publishStartupModelRuntime,
        shouldSkipStartupModelPrewarm,
      },
    } = await import("./server-startup-post-attach.js"));
  });

  beforeEach(() => {
    prepareModelRuntimeSnapshotMock.mockClear();
    refreshPreparedModelRuntimeSnapshotsMock.mockClear();
    readPersistedRuntimeSelectionsMock.mockReset().mockReturnValue(persistedRuntimeSelections);
  });

  it("prewarms an explicit configured primary model", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.4",
          },
        },
      },
    } as OpenClawConfig;

    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      additionalRuntimePluginSelectionsByAgentId: persistedRuntimeSelections,
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("hydrates configured external CLI auth before prepared owner publication", async () => {
    const cfg = {} as OpenClawConfig;
    const hydrate = vi.fn();

    await hydrateConfiguredExternalCliAuth({
      getConfig: () => cfg,
      log: { warn: vi.fn() },
      deps: {
        listAgentIds: () => ["main", "secondary"],
        resolveAgentDir: (_config, agentId) => `/tmp/${agentId}`,
        collectConfiguredRefs: (_config, agentId) => [
          { value: agentId === "main" ? "openai/gpt-5.4" : "anthropic/sonnet-4.6" },
        ],
        hydrate,
      },
    });

    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/main", ["openai"]);
    expect(hydrate).toHaveBeenCalledWith(cfg, "/tmp/secondary", ["anthropic"]);
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("prewarms the default catalog when no explicit primary model is configured", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      additionalRuntimePluginSelectionsByAgentId: persistedRuntimeSelections,
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("honors the startup model prewarm skip env", () => {
    expect(shouldSkipStartupModelPrewarm({})).toBe(false);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      }),
    ).toBe(true);
    expect(
      shouldSkipStartupModelPrewarm({
        OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "true",
      }),
    ).toBe(true);
  });

  it("publishes required runtime snapshots when optional startup prewarm is skipped", async () => {
    vi.stubEnv("OPENCLAW_SKIP_STARTUP_MODEL_PREWARM", "1");
    const optionalPrewarm = vi.fn(async () => {});
    try {
      await publishStartupModelRuntime(
        {
          cfg: {} as OpenClawConfig,
          workspaceDir: "/tmp/skip-explicit-workspace",
          log: { warn: vi.fn() },
        },
        optionalPrewarm,
      );

      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledOnce();
      expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          additionalRuntimePluginSelectionsByAgentId: persistedRuntimeSelections,
          allowGatewaySubagentBinding: true,
          defaultWorkspaceDir: "/tmp/skip-explicit-workspace",
        }),
      );
      expect(optionalPrewarm).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("publishes lifecycle owners for configured CLI backends", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "codex-cli/gpt-5.5",
          },
        },
      },
    } as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({ cfg, log: { warn: vi.fn() } });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      additionalRuntimePluginSelectionsByAgentId: persistedRuntimeSelections,
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
    });
  });

  it("preserves the explicit startup workspace in the published default owner", async () => {
    const cfg = {} as OpenClawConfig;
    await prewarmConfiguredPrimaryModel({
      cfg,
      workspaceDir: "/tmp/explicit-workspace",
      log: { warn: vi.fn() },
    });

    expect(refreshPreparedModelRuntimeSnapshotsMock).toHaveBeenCalledWith(cfg, {
      additionalRuntimePluginSelectionsByAgentId: persistedRuntimeSelections,
      allowGatewaySubagentBinding: true,
      gatewayLifecycle: true,
      catalogMode: "static",
      defaultWorkspaceDir: "/tmp/explicit-workspace",
    });
  });

  it("binds persisted selections to the deferred current config before refresh publication", async () => {
    const staleConfig = { agents: { defaults: { model: { primary: "openai/old" } } } };
    const currentConfig = { agents: { defaults: { model: { primary: "openai/current" } } } };
    const getConfig = vi.fn(async () => currentConfig);
    refreshPreparedModelRuntimeSnapshotsMock.mockImplementationOnce(async (source, options) => {
      expect(getConfig).not.toHaveBeenCalled();
      expect(readPersistedRuntimeSelectionsMock).not.toHaveBeenCalled();
      if (typeof source !== "function") {
        throw new Error("expected deferred current config acquisition");
      }
      expect(await source()).toBe(currentConfig);
      expect(options?.additionalRuntimePluginSelectionsByAgentId).toBe(persistedRuntimeSelections);
    });

    await prewarmConfiguredPrimaryModel({ cfg: staleConfig, getConfig, log: { warn: vi.fn() } });

    expect(getConfig).toHaveBeenCalledOnce();
    expect(readPersistedRuntimeSelectionsMock).toHaveBeenCalledExactlyOnceWith(currentConfig);
  });

  it("does not publish a configured owner when the persisted selection scan is blocked", async () => {
    const error = new Error("persisted selection scan blocked");
    readPersistedRuntimeSelectionsMock.mockImplementationOnce(() => {
      throw error;
    });

    await expect(prewarmConfiguredPrimaryModel({ cfg: {}, log: { warn: vi.fn() } })).rejects.toBe(
      error,
    );
    expect(refreshPreparedModelRuntimeSnapshotsMock).not.toHaveBeenCalled();
  });

  it("propagates lifecycle catalog preparation failure", async () => {
    const error = new Error("models write failed");
    refreshPreparedModelRuntimeSnapshotsMock.mockRejectedValueOnce(error);

    await expect(
      prewarmConfiguredPrimaryModel({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "codex/gpt-5.4",
              },
            },
          },
        } as OpenClawConfig,
        log: { warn: vi.fn() },
      }),
    ).rejects.toBe(error);
  });
});
