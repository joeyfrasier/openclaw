// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { refreshPreparedModelRuntimeSnapshots } from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared model runtime additional selections", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime-selections" });
    resetPreparedModelRuntimeHarness(state);
  });

  it("merges persisted locked-session harness selections into configured startup owners", async () => {
    mocks.configuredAgentIds = ["default"];
    const config = {
      agents: {
        defaults: {
          model: "openai/gpt-5",
          models: {
            "openai/gpt-5": { params: { transport: "sse", openaiWsWarmup: false } },
          },
        },
      },
    };

    await refreshPreparedModelRuntimeSnapshots(config, {
      additionalRuntimePluginSelectionsByAgentId: new Map([
        ["default", [{ provider: "openai", modelId: "gpt-5", runtime: "codex" }]],
      ]),
      catalogMode: "static",
      gatewayLifecycle: true,
    });

    expect(
      mocks.loadAgentRuntimePluginRegistryHandle.mock.calls.map((call) => call[0].selections),
    ).toContainEqual([
      { provider: "openai", modelId: "gpt-5", runtime: "codex" },
      { provider: "openai", modelId: "gpt-5", runtime: "openclaw" },
    ]);
  });
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
