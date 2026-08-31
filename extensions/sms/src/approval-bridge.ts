// Sms approval bridge restricts the canonical OpenClaw exec approval service.
import { createHash } from "node:crypto";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectSmsAccount, resolveSmsAccount } from "./accounts.js";
import { normalizeSmsPhoneNumber } from "./phone.js";

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
  return Boolean(
    account.enabled &&
    account.accountSid &&
    account.authToken &&
    (account.fromNumber || account.messagingServiceSid) &&
    inspection.signatureValidation === "configured" &&
    !account.dangerouslyDisableSignatureValidation &&
    account.dmPolicy === "allowlist" &&
    account.execApprovals?.enabled === true &&
    account.execApprovals.approvers.length > 0 &&
    account.allowTo,
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
  resolved: { id: string; decision: "allow-once" | "allow-always" | "deny" };
}): ReplyPayload {
  const decision =
    params.resolved.decision === "allow-once"
      ? "allowed once"
      : params.resolved.decision === "deny"
        ? "denied"
        : "resolved on another approval surface";
  return { text: `OpenClaw exec approval ${params.resolved.id.slice(0, 8)}: ${decision}.` };
}

export const smsApprovalCapability: ChannelApprovalCapability = {
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
      buildPendingPayload: buildSmsApprovalPendingPayload,
      buildResolvedPayload: buildSmsApprovalResolvedPayload,
    },
  },
};
