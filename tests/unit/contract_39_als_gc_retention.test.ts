import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, test } from "bun:test";

async function waitForCollection(reference: WeakRef<object>): Promise<boolean> {
  // Dereferencing keeps the target alive until the current job ends.
  for (let attempt = 0; attempt < 30; attempt++) {
    await Bun.sleep(5);
    Bun.gc(true);
    if (reference.deref() === undefined) return true;
  }
  return false;
}

// https://github.com/oven-sh/bun/commit/74326db585fe67c2a02bef1119c9e54ab05addf9
describe("AsyncLocalStorage GC retention", () => {
  for (const mode of ["nested-run", "exit"] as const) {
    test(`${mode} does not retain the outer store through a pending timer`, async () => {
      const storage = new AsyncLocalStorage<{ payload: Uint8Array }>();
      function scheduleTimer() {
        const outer = { payload: new Uint8Array(64 * 1024) };
        const reference = new WeakRef(outer);
        const timer = storage.run(outer, () => {
          const schedule = () => setTimeout(() => {}, 3_600_000);
          return mode === "exit"
            ? storage.exit(schedule)
            : storage.run({ payload: new Uint8Array(8) }, schedule);
        });
        return { reference, timer };
      }
      const { reference, timer } = scheduleTimer();
      try {
        expect(await waitForCollection(reference)).toBe(true);
      } finally {
        clearTimeout(timer);
        storage.disable();
      }
    });
  }
});

for (const mode of ["nested-run", "exit"] as const) {
  for (const resource of ["promise", "immediate"] as const) {
    test(`${mode} releases outer ALS payload while ${resource} continuation is pending`, async () => {
      const storage = new AsyncLocalStorage<{ payload: Uint8Array }>();
      const inner = { payload: new Uint8Array(8) };
      const expected = mode === "exit" ? undefined : inner;
      const latch = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const observed: unknown[] = [];
      let immediate: ReturnType<typeof setImmediate> | undefined;
      let pending: Promise<void> | undefined;
      // This function's lexical environment contains no outer payload.
      function arm() {
        if (resource === "promise") {
          pending = latch.promise.then(() => {
            observed.push(storage.getStore());
            completed.resolve();
          });
          started.resolve();
        } else {
          immediate = setImmediate(async () => {
            observed.push(storage.getStore());
            started.resolve();
            try {
              await latch.promise;
              observed.push(storage.getStore());
              completed.resolve();
            } catch (error) {
              completed.reject(error);
            }
          });
        }
      }
      function allocateOuter() {
        const outer = { payload: new Uint8Array(64 * 1024) };
        const reference = new WeakRef(outer);
        storage.run(outer, () => {
          if (mode === "exit") storage.exit(arm);
          else storage.run(inner, arm);
          expect(storage.getStore()).toBe(outer);
        });
        return reference;
      }
      const reference = allocateOuter();
      try {
        await started.promise;
        expect(storage.getStore()).toBeUndefined();
        expect(await waitForCollection(reference)).toBe(true);
        latch.resolve();
        await completed.promise;
        expect(observed).toEqual(
          resource === "promise" ? [expected] : [expected, expected],
        );
      } finally {
        latch.resolve();
        if (immediate !== undefined) clearImmediate(immediate);
        await pending;
        storage.disable();
      }
    });
  }
}
