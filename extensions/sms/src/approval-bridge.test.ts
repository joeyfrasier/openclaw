// Sms tests cover the owner-only exec approval bridge.
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { smsApprovalCapability } from "./approval-bridge.js";

const OWNER = "+15551234567";
const OTHER = "+15559876543";

function createConfig(): OpenClawConfig {
  return {
    channels: {
      sms: {
        enabled: true,
        accountSid: "AC123",
        authToken: "test-token",
        fromNumber: "+15557654321",
        publicWebhookUrl: "https://sms.example.test/webhooks/sms/owner",
        dangerouslyDisableSignatureValidation: false,
        dmPolicy: "allowlist",
        allowFrom: [OWNER],
        allowTo: [OWNER],
        execApprovals: {
          enabled: true,
          approvers: [OWNER],
        },
      },
    },
  } as OpenClawConfig;
}

function createRequest(command = "printf 'customer-secret-123'"): ExecApprovalRequest {
  return {
    id: "abcdefab-1234-5678-9abc-123456789abc",
    expiresAtMs: 61_000,
    request: {
      command,
      commandArgv: ["printf", "customer-secret-123"],
      cwd: "/private/customer/acme",
      host: "gateway",
      agentId: "red",
      sessionKey: `agent:red:sms:direct:${OWNER}`,
      turnSourceChannel: "sms",
      turnSourceTo: OWNER,
      turnSourceAccountId: "default",
      env: { PRIVATE_TOKEN: "do-not-send" },
      ask: "always",
      security: "allowlist",
    },
  } as unknown as ExecApprovalRequest;
}

function buildSmsApprovalPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: { channel: string; to: string; accountId?: string | null };
  nowMs: number;
}) {
  const renderPending = smsApprovalCapability.render?.exec?.buildPendingPayload;
  if (!renderPending) {
    throw new Error("SMS exec approval renderer is unavailable");
  }
  const payload = renderPending(params);
  if (!payload) {
    throw new Error("SMS exec approval renderer returned no payload");
  }
  return payload;
}

function readSmsApprovalActionFingerprint(request: ExecApprovalRequest): string {
  const text = buildSmsApprovalPendingPayload({
    cfg: createConfig(),
    request,
    target: { channel: "sms", to: OWNER, accountId: "default" },
    nowMs: 1_000,
  }).text;
  const fingerprint = /one bounded execution \(([a-f0-9]{12})\)/u.exec(text ?? "")?.[1];
  if (!fingerprint) {
    throw new Error("SMS approval fingerprint is missing");
  }
  return fingerprint;
}

describe("SMS approval bridge", () => {
  it("authorizes only the configured E.164 owner on a signed allowlist account", () => {
    const authorize = smsApprovalCapability.authorizeActorAction;
    expect(authorize).toBeDefined();
    expect(
      authorize?.({
        cfg: createConfig(),
        accountId: "default",
        senderId: OWNER,
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
    for (const senderId of [OTHER, "owner", "sms:+15551234567", null]) {
      expect(
        authorize?.({
          cfg: createConfig(),
          accountId: "default",
          senderId,
          action: "approve",
          approvalKind: "exec",
        }).authorized,
      ).toBe(false);
    }
  });

  it("fails closed when signature validation, allowlist policy, or approvals are disabled", () => {
    const authorize = smsApprovalCapability.authorizeActorAction;
    for (const sms of [
      { ...createConfig().channels?.sms, dangerouslyDisableSignatureValidation: true },
      { ...createConfig().channels?.sms, publicWebhookUrl: "not-an-absolute-url" },
      { ...createConfig().channels?.sms, dmPolicy: "open" },
      {
        ...createConfig().channels?.sms,
        execApprovals: { enabled: false, approvers: [OWNER] },
      },
    ]) {
      expect(
        authorize?.({
          cfg: { channels: { sms } } as OpenClawConfig,
          accountId: "default",
          senderId: OWNER,
          action: "approve",
          approvalKind: "exec",
        }).authorized,
      ).toBe(false);
    }
  });

  it.each([
    { allowFrom: [OWNER], allowTo: [] },
    { allowFrom: [OWNER], allowTo: [OTHER] },
    { allowFrom: [OTHER], allowTo: [OWNER] },
  ])(
    "disables approvals without an approver reachable in both allowlists",
    ({ allowFrom, allowTo }) => {
      const getState = smsApprovalCapability.getActionAvailabilityState;
      const sms = { ...createConfig().channels?.sms, allowFrom, allowTo };

      expect(
        getState?.({
          cfg: { channels: { sms } } as OpenClawConfig,
          accountId: "default",
          approvalKind: "exec",
        }),
      ).toEqual({ kind: "disabled" });
    },
  );

  it("refuses to render an approval prompt for an outbound non-approver", () => {
    const renderPending = smsApprovalCapability.render?.exec?.buildPendingPayload;
    const sms = { ...createConfig().channels?.sms, allowTo: [OWNER, OTHER] };

    expect(() =>
      renderPending?.({
        cfg: { channels: { sms } } as OpenClawConfig,
        request: createRequest(),
        target: { channel: "sms", to: OTHER, accountId: "default" },
        nowMs: 1_000,
      }),
    ).toThrow("SMS_APPROVAL_TARGET_NOT_AUTHORIZED");
  });

  it("exposes allow-once and deny without leaking command, cwd, env, or full approval id", () => {
    const request = createRequest();
    const payload = buildSmsApprovalPendingPayload({
      cfg: createConfig(),
      request,
      target: { channel: "sms", to: OWNER, accountId: "default" },
      nowMs: 1_000,
    });
    expect(payload?.text).toContain("approval abcdefab");
    expect(payload?.text).toContain("/approve abcdefab allow-once");
    expect(payload?.text).toContain("/approve abcdefab deny");
    expect(payload?.text).not.toContain("allow-always");
    expect(payload?.text).not.toContain("customer-secret-123");
    expect(payload?.text).not.toContain("/private/customer/acme");
    expect(payload?.text).not.toContain("PRIVATE_TOKEN");
    expect(payload?.text).not.toContain(request.id);
  });

  it("throws for an unavailable target so generic command-bearing fallback cannot run", () => {
    const renderPending = smsApprovalCapability.render?.exec?.buildPendingPayload;
    expect(() =>
      renderPending?.({
        cfg: { channels: { sms: { enabled: false } } } as OpenClawConfig,
        request: createRequest(),
        target: { channel: "sms", to: OTHER, accountId: "default" },
        nowMs: 1_000,
      }),
    ).toThrow("SMS_APPROVAL_TARGET_NOT_AUTHORIZED");
  });

  it("filters an unauthorized SMS target before generic forwarding fallback", () => {
    const shouldSuppress = smsApprovalCapability.delivery?.shouldSuppressForwardingFallback;
    const sms = { ...createConfig().channels?.sms, allowTo: [OWNER, OTHER] };

    expect(
      shouldSuppress?.({
        cfg: { channels: { sms } } as OpenClawConfig,
        approvalKind: "exec",
        target: { channel: "sms", to: OTHER, accountId: "default" },
        request: createRequest(),
      }),
    ).toBe(true);
    expect(
      shouldSuppress?.({
        cfg: { channels: { sms } } as OpenClawConfig,
        approvalKind: "exec",
        target: { channel: "sms", to: OWNER, accountId: "default" },
        request: createRequest(),
      }),
    ).toBe(false);
  });

  it("changes the opaque action fingerprint whenever a bound action changes", () => {
    const original = readSmsApprovalActionFingerprint(createRequest("printf harmless"));
    const changed = readSmsApprovalActionFingerprint(createRequest("printf changed"));
    expect(original).toMatch(/^[a-f0-9]{12}$/);
    expect(changed).toMatch(/^[a-f0-9]{12}$/);
    expect(changed).not.toBe(original);
  });

  it("rejects allow-always and plugin approvals as unavailable SMS authority", () => {
    const resolveBehavior = smsApprovalCapability.resolveApproveCommandBehavior;
    expect(
      resolveBehavior?.({
        cfg: createConfig(),
        accountId: "default",
        senderId: OWNER,
        approvalKind: "exec",
        decision: "allow-always",
      }),
    ).toEqual({ kind: "reply", text: "SMS approvals support allow-once or deny only." });
    expect(
      resolveBehavior?.({
        cfg: createConfig(),
        accountId: "default",
        senderId: OWNER,
        approvalKind: "plugin",
        decision: "allow-once",
      }),
    ).toEqual({ kind: "reply", text: "SMS can resolve exec approvals only." });
  });

  it("does not report allow-always as a denial when another surface resolved it", () => {
    const renderResolved = smsApprovalCapability.render?.exec?.buildResolvedPayload;
    const payload = renderResolved?.({
      cfg: createConfig(),
      target: { channel: "sms", to: OWNER, accountId: "default" },
      resolved: {
        id: "abcdefab-1234-5678-9abc-123456789abc",
        decision: "allow-always",
        ts: 1_000,
        request: createRequest().request,
      },
    });
    expect(payload?.text).toContain("resolved on another approval surface");
    expect(payload?.text).not.toContain("denied");
  });
});
