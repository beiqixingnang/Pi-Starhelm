import test from "node:test";
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";

const context = new AsyncLocalStorage();
let pending = Promise.resolve();

export const currentTestSignal = () => context.getStore()?.signal;
export const withPiTestSignal = (signal, fn) => context.run({ signal }, fn);

// Node can start the next test after a timeout while the old async body is
// still unwinding. Pi reads its home from process.env, so retain ownership
// through cleanup and never let those bodies share configuration or databases.
export function withPiTestContext(fn, signal) {
  const result = pending.then(async () => {
    signal?.throwIfAborted();
    const previous = process.env.PI_CODING_AGENT_DIR;
    assert.ok(
      previous,
      "Use scripts/test-v2.mjs for an isolated Pi agent directory",
    );
    const directory = await fs.mkdtemp(path.join(previous, "case-"));
    try {
      await fs.copyFile(
        path.join(previous, "settings.json"),
        path.join(directory, "settings.json"),
      );
      signal?.throwIfAborted();
      process.env.PI_CODING_AGENT_DIR = directory;
      return await context.run({ signal }, fn);
    } finally {
      // Do not restore the shared environment or release the queue until every
      // session, worker and test-body finally block has finished.
      try {
        await fs.rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 100,
        });
      } finally {
        process.env.PI_CODING_AGENT_DIR = previous;
      }
    }
  });
  pending = result.catch(() => {});
  return result;
}

export function piTest(name, options, fn) {
  if (typeof options === "function") {
    fn = options;
    options = {};
  }
  // Real members start separate Pi processes (three in the review-gate case).
  // Keep finite stage/RPC deadlines, with a bounded total CI allowance for
  // cold Windows startup and cleanup. Local deadlines stay unchanged.
  const timeout = process.env.CI
    ? Math.max(options.timeout ?? 25000, 90000)
    : (options.timeout ?? 25000);
  return test(name, { ...options, timeout }, (t) =>
    withPiTestContext(() => fn(t), t.signal),
  );
}
