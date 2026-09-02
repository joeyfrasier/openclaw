import { describe, expect, it, vi } from "vitest";
import { createChannelProgressDraftCompositor } from "./progress-draft-compositor.js";

describe("channel progress draft commentary identity", () => {
  it.each([
    { name: "id-bearing first", itemFirst: true },
    { name: "id-less first", itemFirst: false },
  ])("keeps cumulative mixed-identity commentary on one line with $name", async ({ itemFirst }) => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false, commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });
    const snapshots = [
      "I",
      "Accepted. I",
      "Accepted. I’m",
      "Accepted. I’m checking the workspace before replying.",
    ];

    for (const text of snapshots) {
      const idBearing = () => progress.pushCommentaryProgress(text, { itemId: "commentary-1" });
      const idLess = () => progress.pushCommentaryProgress(text);
      await (itemFirst ? idBearing() : idLess());
      await (itemFirst ? idLess() : idBearing());
    }

    const finalSentence = snapshots.at(-1) ?? "";
    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ text: `_${finalSentence}_` }),
    ]);
    expect(update.mock.calls.at(-1)?.[0]).toBe(`_${finalSentence}_`);
    expect(update.mock.calls.at(-1)?.[0].match(/Accepted\./gu) ?? []).toHaveLength(1);
  });

  it("keeps identical commentary from distinct explicit item ids on distinct lines", async () => {
    const update = vi.fn();
    const progress = createChannelProgressDraftCompositor({
      entry: { streaming: { mode: "progress", progress: { label: false, commentary: true } } },
      mode: "progress",
      active: true,
      seed: "test",
      update,
    });

    await progress.pushCommentaryProgress("Checking the workspace.", { itemId: "commentary-1" });
    await progress.pushCommentaryProgress("Checking the workspace.", { itemId: "commentary-2" });

    expect(progress.getSnapshot().lines).toEqual([
      expect.objectContaining({ id: "commentary:commentary-1", text: "_Checking the workspace._" }),
      expect.objectContaining({ id: "commentary:commentary-2", text: "_Checking the workspace._" }),
    ]);
  });
});
