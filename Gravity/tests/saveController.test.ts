import { describe, expect, it } from "vitest";
import { createSaveController } from "../src/state/saveController";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createSaveController", () => {
  it("does not let older async saves overwrite newer committed content", async () => {
    const controller = createSaveController();
    const committed: string[] = [];

    const first = deferred<void>();
    const second = deferred<void>();

    const firstSave = controller.save(
      "old",
      async () => {
        await first.promise;
      },
      (value) => {
        committed.push(value);
      }
    );

    const secondSave = controller.save(
      "new",
      async () => {
        await second.promise;
      },
      (value) => {
        committed.push(value);
      }
    );

    second.resolve();
    await secondSave;

    first.resolve();
    await firstSave;

    expect(committed).toEqual(["new"]);
  });
});