import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJob } from "../types.js";
import {
  MORNING_BRIEF_CRON_JOB_ID,
  type MorningBriefContentGateResult,
} from "./morning-brief-content-gate.js";
import {
  clearFastTestEnv,
  dispatchCronDeliveryMock,
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronPayloadOutcomeMock,
  resolveDeliveryTargetMock,
  restoreFastTestEnv,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runGateMock = vi.hoisted(() => vi.fn<() => Promise<MorningBriefContentGateResult>>());
vi.mock("./morning-brief-content-gate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./morning-brief-content-gate.js")>()),
  runMorningBriefContentGate: runGateMock,
}));

const { resolveCronPayloadOutcome } =
  await vi.importActual<typeof import("./helpers.js")>("./helpers.js");
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const DRAFT_PATH = "/private/fixture/work/morning-brief-gate.md";
const UNGATED_REPLY = "Delivering the brief as-is: private fixture content";

function runMorningBrief() {
  return runCronIsolatedAgentTurn({
    cfg: {},
    deps: {} as never,
    job: {
      id: MORNING_BRIEF_CRON_JOB_ID,
      name: "Morning brief fixture",
      schedule: { kind: "cron", expr: "15 8 * * 1-5", tz: "America/New_York" },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "Prepare a draft" },
      delivery: { mode: "announce", channel: "slack", to: "fixture-room" },
      state: {},
    } as CronJob,
    message: "Prepare a draft",
    sessionKey: "cron:morning-brief-fixture",
  });
}

describe("morning brief delivery gate", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    resetRunCronIsolatedAgentTurnHarness();
    previousFastTestEnv = clearFastTestEnv();
    mockRunCronFallbackPassthrough();
    resolveCronPayloadOutcomeMock.mockImplementation(resolveCronPayloadOutcome);
    resolveCronDeliveryPlanMock.mockReturnValue({
      requested: true,
      mode: "announce",
      channel: "slack",
      to: "fixture-room",
    });
    resolveDeliveryTargetMock.mockResolvedValue({
      ok: true,
      channel: "slack",
      to: "fixture-room",
      mode: "explicit",
    });
    runEmbeddedAgentMock.mockResolvedValue({
      payloads: [{ text: UNGATED_REPLY }],
      meta: { agentMeta: {} },
    });
    runGateMock.mockReset();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("replaces the model's fail-open reply with only the successful gated text", async () => {
    runGateMock.mockImplementation(async () => {
      expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
      return { ok: true, text: "safe gated fixture", draftPath: DRAFT_PATH };
    });

    const result = await runMorningBrief();

    expect(runGateMock).toHaveBeenCalledOnce();
    expect(runEmbeddedAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ disableMessageTool: true }),
    );
    expect(dispatchCronDeliveryMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        deliveryPayloads: [{ text: "safe gated fixture" }],
        synthesizedText: "safe gated fixture",
        outputText: "safe gated fixture",
      }),
    );
    expect(result).toMatchObject({ status: "ok", delivered: true });
    expect(JSON.stringify(dispatchCronDeliveryMock.mock.calls)).not.toContain(UNGATED_REPLY);
  });

  it.each(["HEARTBEAT_OK", "NO_REPLY", ""])(
    "delivers successful gated text when the model returns %j",
    async (modelText) => {
      runEmbeddedAgentMock.mockResolvedValue({
        payloads: modelText ? [{ text: modelText }] : [],
        meta: { agentMeta: {} },
      });
      runGateMock.mockResolvedValue({
        ok: true,
        text: "safe gated fixture",
        draftPath: DRAFT_PATH,
      });

      const result = await runMorningBrief();

      expect(dispatchCronDeliveryMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          deliveryPayloads: [{ text: "safe gated fixture" }],
          synthesizedText: "safe gated fixture",
          outputText: "safe gated fixture",
        }),
      );
      expect(result).toMatchObject({ status: "ok", delivered: true });
    },
  );

  it.each([
    { stage: "check", reason: "flagged" },
    { stage: "secure", reason: "unavailable" },
    { stage: "scrub", reason: "timed-out" },
    { stage: "cleanup", reason: "failed" },
  ] as const)("does not dispatch after $stage is $reason", async ({ stage, reason }) => {
    runGateMock.mockResolvedValue({ ok: false, stage, reason, draftPath: DRAFT_PATH });

    const result = await runMorningBrief();

    expect(runGateMock).toHaveBeenCalledOnce();
    expect(dispatchCronDeliveryMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "error",
      delivered: false,
      deliveryAttempted: false,
      error: expect.stringContaining(`${stage} (${reason})`),
      outputText: expect.stringContaining(DRAFT_PATH),
    });
    expect(result.outputText).not.toContain(UNGATED_REPLY);
  });
});
