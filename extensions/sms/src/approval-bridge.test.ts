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

function renderPending(request: ExecApprovalRequest, cfg = createConfig(), to = OWNER) {
  const render = smsApprovalCapability.render?.exec?.buildPendingPayload;
  if (!render) {
    throw new Error("SMS approval pending renderer is unavailable");
  }
  const payload = render({
    cfg,
    request,
    target: { channel: "sms", to, accountId: "default" },
    nowMs: 1_000,
  });
  if (!payload?.text) {
    throw new Error("SMS approval pending renderer returned no text");
  }
  return { ...payload, text: payload.text };
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

  it("exposes allow-once and deny without leaking command, cwd, env, or full approval id", () => {
    const request = createRequest();
    const payload = renderPending(request);
    expect(payload?.text).toContain("approval abcdefab");
    expect(payload?.text).toContain("/approve abcdefab allow-once");
    expect(payload?.text).toContain("/approve abcdefab deny");
    expect(payload?.text).not.toContain("allow-always");
    expect(payload?.text).not.toContain("customer-secret-123");
    expect(payload?.text).not.toContain("/private/customer/acme");
    expect(payload?.text).not.toContain("PRIVATE_TOKEN");
    expect(payload?.text).not.toContain(request.id);
  });

  it("always renders a redacted prompt so generic command-bearing fallback cannot run", () => {
    const payload = renderPending(
      createRequest(),
      { channels: { sms: { enabled: false } } } as OpenClawConfig,
      OTHER,
    );
    expect(payload.text).toContain("one bounded execution");
    expect(payload.text).not.toContain("customer-secret-123");
    expect(payload.text).not.toContain("/private/customer/acme");
  });

  it("changes the opaque action fingerprint whenever a bound action changes", () => {
    const fingerprint = (command: string) =>
      renderPending(createRequest(command)).text.match(/\(([a-f0-9]{12})\)/u)?.[1];
    const original = fingerprint("printf harmless");
    const changed = fingerprint("printf changed");
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
