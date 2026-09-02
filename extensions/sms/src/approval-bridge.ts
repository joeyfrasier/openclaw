// Sms approval bridge restricts the canonical OpenClaw exec approval service.
import { createHash } from "node:crypto";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectSmsAccount, resolveSmsAccount } from "./accounts.js";
import { looksLikeSmsPhoneNumber, normalizeSmsPhoneNumber } from "./phone.js";

const SMS_APPROVAL_DECISIONS = ["allow-once", "deny"] as const;

function formatExpiresIn(expiresAtMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)}m`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function resolveActionBinding(request: ExecApprovalRequest): unknown {
  const payload = request.request;
  return (
    payload.systemRunBinding ??
    payload.systemRunPlan ?? {
      agentId: payload.agentId,
      command: payload.command,
      commandArgv: payload.commandArgv,
      cwd: payload.cwd,
      envKeys: payload.envKeys,
      host: payload.host,
      nodeId: payload.nodeId,
      runId: payload.runId,
      sessionKey: payload.sessionKey,
      toolCallId: payload.toolCallId,
    }
  );
}

function buildSmsApprovalActionFingerprint(request: ExecApprovalRequest): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(resolveActionBinding(request))))
    .digest("hex")
    .slice(0, 12);
}

function isSmsApprovalAccountSafe(params: {
  cfg: Parameters<NonNullable<ChannelApprovalCapability["authorizeActorAction"]>>[0]["cfg"];
  accountId?: string | null;
}): boolean {
  const account = resolveSmsAccount(params.cfg, params.accountId);
  const inspection = inspectSmsAccount(params.cfg, params.accountId);
  const reachableApprover = (account.execApprovals?.approvers ?? []).some(
    (approver) =>
      looksLikeSmsPhoneNumber(approver) &&
      account.allowFrom.includes(approver) &&
      account.allowTo?.includes(approver),
  );
  return Boolean(
    account.enabled &&
    account.accountSid &&
    account.authToken &&
    (account.fromNumber || account.messagingServiceSid) &&
    inspection.signatureValidation === "configured" &&
    !account.dangerouslyDisableSignatureValidation &&
    account.dmPolicy === "allowlist" &&
    account.execApprovals?.enabled === true &&
    reachableApprover,
  );
}

function isSmsApprovalOwner(params: {
  cfg: Parameters<NonNullable<ChannelApprovalCapability["authorizeActorAction"]>>[0]["cfg"];
  accountId?: string | null;
  senderId?: string | null;
}): boolean {
  const account = resolveSmsAccount(params.cfg, params.accountId);
  const rawSenderId = params.senderId?.trim() ?? "";
  const senderId = normalizeSmsPhoneNumber(rawSenderId);
  const approvers = account.execApprovals?.approvers ?? [];
  return Boolean(
    isSmsApprovalAccountSafe(params) &&
    senderId &&
    rawSenderId === senderId &&
    account.allowFrom.includes(senderId) &&
    account.allowTo?.includes(senderId) &&
    approvers.includes(senderId),
  );
}

function buildSmsApprovalPendingPayload(params: {
  cfg: OpenClawConfig;
  request: ExecApprovalRequest;
  target: { channel: string; to: string; accountId?: string | null };
  nowMs: number;
}): ReplyPayload {
  // Rendering is the final delivery boundary. A configured outbound target is
  // not necessarily an approval owner, so refuse to disclose even the opaque
  // approval slug unless the exact recipient can also authorize the reply.
  if (
    !isSmsApprovalOwner({
      cfg: params.cfg,
      accountId: params.target.accountId,
      senderId: params.target.to,
    })
  ) {
    // Throw instead of returning null: the generic forwarding layer treats a
    // null channel payload as permission to render its command-bearing fallback.
    throw new Error("SMS_APPROVAL_TARGET_NOT_AUTHORIZED");
  }
  const approvalSlug = params.request.id.slice(0, 8);
  const fingerprint = buildSmsApprovalActionFingerprint(params.request);
  const expiresIn = formatExpiresIn(params.request.expiresAtMs, params.nowMs);
  return {
    text: [
      `OpenClaw exec approval ${approvalSlug}`,
      `Action: one bounded execution (${fingerprint})`,
      `Expires in: ${expiresIn}`,
      `Allow once: /approve ${approvalSlug} allow-once`,
      `Deny: /approve ${approvalSlug} deny`,
    ].join("\n"),
  };
}

function buildSmsApprovalResolvedPayload(params: {
  cfg: OpenClawConfig;
  resolved: { id: string; decision: "allow-once" | "allow-always" | "deny" };
  target: { channel: string; to: string; accountId?: string | null };
}): ReplyPayload {
  // Re-check ownership at final delivery: a recipient authorized for the
  // pending request may have been removed before another surface resolves it.
  if (
    !isSmsApprovalOwner({
      cfg: params.cfg,
      accountId: params.target.accountId,
      senderId: params.target.to,
    })
  ) {
    throw new Error("SMS_APPROVAL_TARGET_NOT_AUTHORIZED");
  }
  const decision =
    params.resolved.decision === "allow-once"
      ? "allowed once"
      : params.resolved.decision === "deny"
        ? "denied"
        : "resolved on another approval surface";
  return { text: `OpenClaw exec approval ${params.resolved.id.slice(0, 8)}: ${decision}.` };
}

function buildSmsApprovalExpiredPayload(params: {
  cfg: OpenClawConfig;
  request: { id: string };
  target: { channel: string; to: string; accountId?: string | null };
}): ReplyPayload {
  // Expiry runs after the pending prompt and must use the latest config. A
  // removed approver receives neither the opaque slug nor any generic fallback.
  if (
    !isSmsApprovalOwner({
      cfg: params.cfg,
      accountId: params.target.accountId,
      senderId: params.target.to,
    })
  ) {
    throw new Error("SMS_APPROVAL_TARGET_NOT_AUTHORIZED");
  }
  return { text: `OpenClaw exec approval ${params.request.id.slice(0, 8)}: expired.` };
}

export const smsApprovalCapability: ChannelApprovalCapability = {
  delivery: {
    shouldSuppressForwardingFallback: ({ cfg, approvalKind, target }) =>
      approvalKind === "exec" &&
      !isSmsApprovalOwner({
        cfg,
        accountId: target.accountId,
        senderId: target.to,
      }),
  },
  authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) => {
    if (approvalKind !== "exec") {
      return { authorized: false, reason: "SMS can resolve exec approvals only." };
    }
    return isSmsApprovalOwner({ cfg, accountId, senderId })
      ? { authorized: true }
      : { authorized: false, reason: "SMS approval sender is not authorized." };
  },
  getActionAvailabilityState: ({ cfg, accountId, approvalKind }) => ({
    kind:
      approvalKind !== "plugin" && isSmsApprovalAccountSafe({ cfg, accountId })
        ? "enabled"
        : "disabled",
  }),
  getExecInitiatingSurfaceState: ({ cfg, accountId }) => ({
    kind: isSmsApprovalAccountSafe({ cfg, accountId }) ? "enabled" : "disabled",
  }),
  resolveApproveCommandBehavior: ({ approvalKind, decision }) => {
    if (approvalKind !== "exec") {
      return { kind: "reply", text: "SMS can resolve exec approvals only." };
    }
    if (decision !== SMS_APPROVAL_DECISIONS[0] && decision !== SMS_APPROVAL_DECISIONS[1]) {
      return { kind: "reply", text: "SMS approvals support allow-once or deny only." };
    }
    return { kind: "allow" };
  },
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default" ? `channels.sms.accounts.${accountId}` : "channels.sms";
    return `Configure ${prefix}.execApprovals.enabled=true with one E.164 approver present in ${prefix}.allowFrom and ${prefix}.allowTo. Keep signature validation enabled.`;
  },
  render: {
    exec: {
      buildExpiredPayload: buildSmsApprovalExpiredPayload,
      buildPendingPayload: buildSmsApprovalPendingPayload,
      buildResolvedPayload: buildSmsApprovalResolvedPayload,
    },
  },
};
