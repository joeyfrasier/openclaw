import { existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { SpawnResult } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";

/** The existing Red morning-brief automation whose Slack delivery is gated. */
export const MORNING_BRIEF_CRON_JOB_ID = "8781d5da-f913-44fb-9c13-17a21b8e8681";

const CONTENT_GATE_TIMEOUT_MS = 10_000;
const CONTENT_GATE_MAX_OUTPUT_BYTES = 512 * 1024;

export type MorningBriefContentGateStage = "secure" | "check" | "scrub" | "cleanup";

export type MorningBriefContentGateResult =
  | {
      ok: true;
      text: string;
      draftPath: string;
    }
  | {
      ok: false;
      stage: MorningBriefContentGateStage;
      draftPath: string;
      reason:
        | "unavailable"
        | "failed"
        | "timed-out"
        | "flagged"
        | "invalid-verdict"
        | "empty-output"
        | "draft-not-removed"
        | "stale-draft";
    };

export type MorningBriefContentGatePaths = {
  draftPath: string;
  secureScript: string;
  contentGateScript: string;
  cleanupScript: string;
};

type MorningBriefContentGateFailureReason =
  | "unavailable"
  | "failed"
  | "timed-out"
  | "flagged"
  | "invalid-verdict"
  | "empty-output"
  | "draft-not-removed"
  | "stale-draft";

export type MorningBriefContentGateOptions = {
  paths?: Partial<MorningBriefContentGatePaths>;
  runCommand?: typeof runCommandWithTimeout;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Rejects a leftover draft from an earlier run. */
  minimumDraftMtimeMs?: number;
};

export function resolveMorningBriefContentGatePaths(
  home = homedir(),
): MorningBriefContentGatePaths {
  return {
    draftPath: path.join(home, "dev", "red", "workspace", "work", "morning-brief-gate.md"),
    secureScript: path.join(
      home,
      ".openclaw",
      "skills",
      "content-gate",
      "scripts",
      "secure-morning-brief-draft.py",
    ),
    contentGateScript: path.join(home, ".openclaw", "skills", "content-gate", "content-gate.py"),
    cleanupScript: path.join(
      home,
      ".openclaw",
      "skills",
      "content-gate",
      "scripts",
      "cleanup-morning-brief-draft.py",
    ),
  };
}

function isSuccessful(result: SpawnResult): boolean {
  return (
    result.code === 0 && result.signal === null && !result.killed && result.termination === "exit"
  );
}

function failure(
  stage: MorningBriefContentGateStage,
  draftPath: string,
  reason: MorningBriefContentGateFailureReason,
): MorningBriefContentGateResult {
  return { ok: false, stage, draftPath, reason };
}

function classifyCommandFailure(result: SpawnResult): "unavailable" | "failed" | "timed-out" {
  if (result.termination === "timeout" || result.termination === "no-output-timeout") {
    return "timed-out";
  }
  return result.code === null ? "unavailable" : "failed";
}

/**
 * Runs Red's canonical secure/check/scrub/cleanup commands outside the model
 * tool loop. Only a passing check and successful cleanup make text deliverable.
 */
export async function runMorningBriefContentGate(
  options: MorningBriefContentGateOptions = {},
): Promise<MorningBriefContentGateResult> {
  const defaults = resolveMorningBriefContentGatePaths();
  const paths: MorningBriefContentGatePaths = {
    ...defaults,
    ...options.paths,
  };
  const runCommand = options.runCommand ?? runCommandWithTimeout;
  const timeoutMs = options.timeoutMs ?? CONTENT_GATE_TIMEOUT_MS;
  const commandOptions = {
    timeoutMs,
    maxOutputBytes: CONTENT_GATE_MAX_OUTPUT_BYTES,
    killProcessTree: true,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  let secure: SpawnResult;
  try {
    secure = await runCommand([paths.secureScript], commandOptions);
  } catch {
    return failure("secure", paths.draftPath, "unavailable");
  }
  if (!isSuccessful(secure)) {
    return failure("secure", paths.draftPath, classifyCommandFailure(secure));
  }
  if (options.minimumDraftMtimeMs !== undefined) {
    try {
      const draft = lstatSync(paths.draftPath);
      if (
        !draft.isFile() ||
        draft.isSymbolicLink() ||
        draft.mtimeMs < options.minimumDraftMtimeMs
      ) {
        return failure("secure", paths.draftPath, "stale-draft");
      }
    } catch {
      return failure("secure", paths.draftPath, "failed");
    }
  }

  let check: SpawnResult;
  try {
    check = await runCommand(
      [paths.contentGateScript, "--mode", "check", "--json", "--file", paths.draftPath],
      commandOptions,
    );
  } catch {
    return failure("check", paths.draftPath, "unavailable");
  }
  if (check.termination === "timeout" || check.termination === "no-output-timeout") {
    return failure("check", paths.draftPath, "timed-out");
  }
  if (check.code === 1) {
    return failure("check", paths.draftPath, "flagged");
  }
  if (!isSuccessful(check)) {
    return failure("check", paths.draftPath, classifyCommandFailure(check));
  }
  try {
    // SAFETY: The two asserted properties are validated against exact primitive values before use.
    const verdict = JSON.parse(check.stdout) as { verdict?: unknown; flag_count?: unknown };
    if (verdict.verdict !== "pass" || verdict.flag_count !== 0) {
      return failure("check", paths.draftPath, "invalid-verdict");
    }
  } catch {
    return failure("check", paths.draftPath, "invalid-verdict");
  }

  let scrub: SpawnResult;
  try {
    scrub = await runCommand(
      [paths.contentGateScript, "--mode", "scrub", "--file", paths.draftPath],
      commandOptions,
    );
  } catch {
    return failure("scrub", paths.draftPath, "unavailable");
  }
  if (!isSuccessful(scrub)) {
    return failure("scrub", paths.draftPath, classifyCommandFailure(scrub));
  }
  const text = scrub.stdout.trim();
  if (!text) {
    return failure("scrub", paths.draftPath, "empty-output");
  }

  let cleanup: SpawnResult;
  try {
    cleanup = await runCommand([paths.cleanupScript], commandOptions);
  } catch {
    return failure("cleanup", paths.draftPath, "unavailable");
  }
  if (!isSuccessful(cleanup)) {
    return failure("cleanup", paths.draftPath, classifyCommandFailure(cleanup));
  }

  // The canonical cleanup helper must have removed the draft before the text
  // can become eligible for delivery. A leftover file means the lifecycle is
  // incomplete, so fail closed even though the process returned exit 0.
  try {
    if (existsSync(paths.draftPath)) {
      return failure("cleanup", paths.draftPath, "draft-not-removed");
    }
  } catch {
    return failure("cleanup", paths.draftPath, "failed");
  }

  return { ok: true, text, draftPath: paths.draftPath };
}
