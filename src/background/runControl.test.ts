import { describe, expect, it } from "vitest";
import { createRunControl, isRunStoppedError } from "./runControl";

describe("run control", () => {
  it("pauses checkpoint work until resume is accepted", async () => {
    const control = createRunControl();

    expect(control.getState()).toBe("running");
    expect(control.pause()).toBe(true);
    expect(control.pause()).toBe(false);
    expect(control.getState()).toBe("paused");

    let checkpointSettled = false;
    const checkpoint = control.checkpoint().then(() => {
      checkpointSettled = true;
    });
    await Promise.resolve();

    expect(checkpointSettled).toBe(false);
    expect(control.resume()).toBe(true);
    expect(control.resume()).toBe(false);
    await checkpoint;

    expect(checkpointSettled).toBe(true);
    expect(control.getState()).toBe("running");
  });

  it("rejects paused checkpoint work when stopped", async () => {
    const control = createRunControl();
    expect(control.pause()).toBe(true);

    const checkpoint = control.checkpoint();
    await Promise.resolve();

    expect(control.stop()).toBe(true);
    expect(control.stop()).toBe(false);
    expect(control.getState()).toBe("stopped");
    expect(control.signal.aborted).toBe(true);
    await expect(checkpoint).rejects.toSatisfy(isRunStoppedError);
  });
});
