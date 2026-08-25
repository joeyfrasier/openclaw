// SMS disposable tests prove approval settlement without external side effects.
import { describe, expect, it } from "vitest";
import type { ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  buildSystemRunApprovalBinding,
  matchSystemRunApprovalBinding,
} from "../infra/system-run-approval-binding.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";

const OWNER_SESSION = "agent:main:sms:direct:+15551234567";

function createBoundRequest(command: string): ExecApprovalRequestPayload {
  const argv = ["printf", "%s", command];
  const { binding } = buildSystemRunApprovalBinding({
    argv,
    cwd: "/tmp/openclaw-sms-canary",
    agentId: "main",
    sessionKey: OWNER_SESSION,
  });
  return {
    command: argv.join(" "),
    commandArgv: argv,
    cwd: binding.cwd,
    host: "gateway",
    agentId: binding.agentId,
    sessionKey: binding.sessionKey,
    systemRunBinding: binding,
    allowedDecisions: ["allow-once", "deny"],
  };
}

function register(manager: ExecApprovalManager, id: string) {
  const record = manager.create(createBoundRequest("harmless-canary"), 60_000, id);
  return { record, decision: manager.register(record, 60_000) };
}

describe("disposable SMS approval contract", () => {
  it("executes one exact harmless action once and rejects changed or replayed actions", async () => {
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      resolveAllowedDecisions: (request) => request.allowedDecisions ?? ["deny"],
    });
    const { record, decision } = register(manager, "abcdefab-1234-5678-9abc-123456789abc");

    expect(manager.resolve(record.id, "allow-once", "sms:default")).toBe(true);
    await expect(decision).resolves.toBe("allow-once");
    const expected = record.request.systemRunBinding;
    if (!expected) {
      throw new Error("expected a bound system.run approval");
    }
    const changed = buildSystemRunApprovalBinding({
      argv: ["printf", "%s", "changed-action"],
      cwd: expected.cwd,
      agentId: expected.agentId,
      sessionKey: expected.sessionKey,
    }).binding;
    expect(
      matchSystemRunApprovalBinding({ expected, actual: changed, actualEnvKeys: [] }),
    ).toMatchObject({ ok: false, code: "APPROVAL_REQUEST_MISMATCH" });

    let executions = 0;
    const executeIfAuthorized = (actual: typeof expected) => {
      if (
        matchSystemRunApprovalBinding({ expected, actual, actualEnvKeys: [] }).ok &&
        manager.consumeAllowOnce(record.id, "sms-disposable-canary")
      ) {
        executions += 1;
      }
    };
    executeIfAuthorized(expected);
    executeIfAuthorized(expected);
    executeIfAuthorized(changed);
    expect(executions).toBe(1);
    expect(manager.resolve(record.id, "deny", "sms:default")).toBe(false);
  });

  it("settles deny and timeout without minting execution authority", async () => {
    const deniedManager = new ExecApprovalManager();
    const denied = register(deniedManager, "bcdefabc-1234-5678-9abc-123456789abc");
    expect(deniedManager.resolve(denied.record.id, "deny", "sms:default")).toBe(true);
    await expect(denied.decision).resolves.toBe("deny");
    expect(deniedManager.consumeAllowOnce(denied.record.id)).toBe(false);

    const expiredManager = new ExecApprovalManager();
    const expired = register(expiredManager, "cdefabcd-1234-5678-9abc-123456789abc");
    expect(expiredManager.expire(expired.record.id, "sms-timeout")).toBe(true);
    await expect(expired.decision).resolves.toBeNull();
    expect(expiredManager.consumeAllowOnce(expired.record.id)).toBe(false);
    expect(expiredManager.resolve(expired.record.id, "allow-once", "sms:default")).toBe(false);
  });

  it("rejects malformed approval ids before registration", () => {
    const manager = new ExecApprovalManager();
    expect(() => manager.create(createBoundRequest("harmless-canary"), 60_000, "bad id")).toThrow(
      /approval id must be/,
    );
  });
});
