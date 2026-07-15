import { beforeEach, describe, expect, it } from "vitest";

import { activate, deactivate } from "../extension";
import { registeredCommands, commands as vscodeCommands } from "./__mocks__/vscode";

describe("extension activate smoke", () => {
  beforeEach(() => {
    registeredCommands.clear();
  });

  it("registers core conflict commands on activate", async () => {
    const subscriptions: Array<{ dispose(): void }> = [];
    const context = {
      subscriptions,
      secrets: {
        get: async () => undefined,
      },
    };

    await activate(context as never);
    deactivate();

    const expected = [
      "conflictResolver.goToConflict",
      "conflictResolver.acceptCurrentConflict",
      "conflictResolver.acceptIncomingConflict",
      "conflictResolver.acceptBothConflict",
      "conflictResolver.batchAcceptCurrent",
      "conflictResolver.batchAcceptIncoming",
      "conflictResolver.batchAcceptBoth",
      "conflictResolver.undoLastAccept",
      "conflictResolver.nextConflict",
      "conflictResolver.previousConflict",
    ];

    for (const commandId of expected) {
      expect(registeredCommands.has(commandId), `missing ${commandId}`).toBe(true);
    }

    expect(subscriptions.length).toBeGreaterThan(0);
  });

  it("detects built-in merge-conflict accept commands", async () => {
    const available = await vscodeCommands.getCommands(true);
    expect(available).toContain("merge-conflict.accept.current");
    expect(available).toContain("merge-conflict.accept.incoming");
    expect(available).toContain("merge-conflict.accept.both");
  });
});
