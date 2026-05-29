export class RunStoppedError extends Error {
  constructor(message = "Run stopped.") {
    super(message);
    this.name = "RunStoppedError";
  }
}

export type RunControlState = "running" | "paused" | "stopped";

export type RunControl = {
  readonly signal: AbortSignal;
  getState: () => RunControlState;
  pause: () => boolean;
  resume: () => boolean;
  stop: () => boolean;
  checkpoint: () => Promise<void>;
};

export function createRunControl(): RunControl {
  const controller = new AbortController();
  let state: RunControlState = "running";
  let resumePausedRun: (() => void) | undefined;

  const throwIfStopped = () => {
    if (state === "stopped" || controller.signal.aborted) {
      throw new RunStoppedError();
    }
  };

  return {
    signal: controller.signal,
    getState: () => state,
    pause: () => {
      if (state !== "running") {
        return false;
      }

      state = "paused";
      return true;
    },
    resume: () => {
      if (state !== "paused") {
        return false;
      }

      state = "running";
      resumePausedRun?.();
      resumePausedRun = undefined;
      return true;
    },
    stop: () => {
      if (state === "stopped") {
        return false;
      }

      state = "stopped";
      resumePausedRun?.();
      resumePausedRun = undefined;
      controller.abort(new RunStoppedError());
      return true;
    },
    checkpoint: async () => {
      throwIfStopped();

      if (state !== "paused") {
        return;
      }

      await new Promise<void>((resolve) => {
        resumePausedRun = resolve;
      });
      throwIfStopped();
    }
  };
}

export function isRunStoppedError(error: unknown): boolean {
  return error instanceof RunStoppedError ||
    error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && /run stopped|operation was aborted|aborterror/i.test(error.message);
}
