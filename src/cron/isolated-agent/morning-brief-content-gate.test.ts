import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SpawnResult } from "../../process/exec-result.js";
import { runMorningBriefContentGate } from "./morning-brief-content-gate.js";

type MorningBriefContentGatePaths = {
  draftPath: string;
  secureScript: string;
  contentGateScript: string;
  cleanupScript: string;
};

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function result(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

async function fixturePaths(): Promise<MorningBriefContentGatePaths> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-content-gate-"));
  tempDirs.push(dir);
  return {
    draftPath: path.join(dir, "morning-brief-gate.md"),
    secureScript: path.join(dir, "secure.py"),
    contentGateScript: path.join(dir, "content-gate.py"),
    cleanupScript: path.join(dir, "cleanup.py"),
  };
}

describe("runMorningBriefContentGate", () => {
  it("runs secure, check, scrub, and cleanup before returning gated text", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.draftPath, "safe draft");
    const calls: string[][] = [];
    const runCommand = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === paths.cleanupScript) {
        await rm(paths.draftPath, { force: true });
      }
      if (argv[0] === paths.contentGateScript && argv[2] === "check") {
        return result({ stdout: '{"verdict":"pass","flag_count":0,"flags":[]}' });
      }
      if (argv[0] === paths.contentGateScript && argv[2] === "scrub") {
        return result({ stdout: "safe draft\n" });
      }
      return result();
    };

    await expect(runMorningBriefContentGate({ paths, runCommand })).resolves.toEqual({
      ok: true,
      text: "safe draft",
      draftPath: paths.draftPath,
    });
    expect(calls.map((argv) => argv[0])).toEqual([
      paths.secureScript,
      paths.contentGateScript,
      paths.contentGateScript,
      paths.cleanupScript,
    ]);
    expect(calls[1]).toEqual([
      paths.contentGateScript,
      "--mode",
      "check",
      "--json",
      "--file",
      paths.draftPath,
    ]);
    expect(calls[2]).toEqual([
      paths.contentGateScript,
      "--mode",
      "scrub",
      "--file",
      paths.draftPath,
    ]);
  });

  it("blocks a flagged draft and does not scrub or clean it", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.draftPath, "sensitive fixture");
    const calls: string[][] = [];
    const runCommand = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === paths.contentGateScript) {
        return result({
          code: 1,
          stdout: '{"verdict":"flag","flag_count":1,"flags":[]}',
        });
      }
      return result();
    };

    await expect(runMorningBriefContentGate({ paths, runCommand })).resolves.toMatchObject({
      ok: false,
      stage: "check",
      reason: "flagged",
      draftPath: paths.draftPath,
    });
    expect(calls.map((argv) => argv[0])).toEqual([paths.secureScript, paths.contentGateScript]);
  });

  it("fails closed when a gate command is unavailable or times out", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.draftPath, "safe fixture");
    await expect(
      runMorningBriefContentGate({
        paths,
        runCommand: async () => {
          throw new Error("spawn failed");
        },
      }),
    ).resolves.toMatchObject({ ok: false, stage: "secure", reason: "unavailable" });

    await expect(
      runMorningBriefContentGate({
        paths,
        runCommand: async () => result({ code: null, termination: "timeout" }),
      }),
    ).resolves.toMatchObject({ ok: false, stage: "secure", reason: "timed-out" });
  });

  it("rejects a leftover draft from before the current run", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.draftPath, "old fixture");

    await expect(
      runMorningBriefContentGate({
        paths,
        minimumDraftMtimeMs: Date.now() + 1_000,
        runCommand: async () => result(),
      }),
    ).resolves.toMatchObject({
      ok: false,
      stage: "secure",
      reason: "stale-draft",
      draftPath: paths.draftPath,
    });
  });

  it("fails closed when cleanup exits successfully but leaves the draft", async () => {
    const paths = await fixturePaths();
    await writeFile(paths.draftPath, "safe fixture");
    const runCommand = async (argv: string[]) => {
      if (argv[0] === paths.contentGateScript && argv[2] === "check") {
        return result({ stdout: '{"verdict":"pass","flag_count":0}' });
      }
      if (argv[0] === paths.contentGateScript && argv[2] === "scrub") {
        return result({ stdout: "safe fixture" });
      }
      return result();
    };

    await expect(runMorningBriefContentGate({ paths, runCommand })).resolves.toMatchObject({
      ok: false,
      stage: "cleanup",
      reason: "draft-not-removed",
    });
  });
});
