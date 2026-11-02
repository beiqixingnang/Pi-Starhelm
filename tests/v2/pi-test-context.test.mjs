import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { currentTestSignal, withPiTestContext } from "./pi-test-context.mjs";

test("a cancelled Pi test retains its home until cleanup and cannot rewrite the next test's configuration", async () => {
  const original = process.env.PI_CODING_AGENT_DIR;
  const controller = new AbortController();
  const cancelled = new Error("Synthetic test deadline");
  let firstDirectory, enter;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const order = [];
  const first = withPiTestContext(async () => {
    firstDirectory = process.env.PI_CODING_AGENT_DIR;
    assert.equal(currentTestSignal(), controller.signal);
    await fs.writeFile(
      path.join(firstDirectory, "mission-control.json"),
      '{"case":1}',
    );
    enter();
    await new Promise((resolve) =>
      controller.signal.addEventListener("abort", resolve, { once: true }),
    );
    // Reproduce an async test body still unwinding after Node cancels it.
    await delay(30);
    assert.equal(process.env.PI_CODING_AGENT_DIR, firstDirectory);
    await fs.writeFile(
      path.join(process.env.PI_CODING_AGENT_DIR, "mission-control.json"),
      '{"late":true}',
    );
    order.push("first cleaned up");
    controller.signal.throwIfAborted();
  }, controller.signal);
  const rejected = assert.rejects(first, (error) => error === cancelled);
  await entered;
  const second = withPiTestContext(async () => {
    order.push("second started");
    const directory = process.env.PI_CODING_AGENT_DIR;
    assert.notEqual(directory, firstDirectory);
    await assert.rejects(fs.access(firstDirectory), { code: "ENOENT" });
    await assert.rejects(
      fs.readFile(path.join(directory, "mission-control.json")),
      { code: "ENOENT" },
    );
    await fs.writeFile(
      path.join(directory, "mission-control.json"),
      '{"case":2}',
    );
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(path.join(directory, "mission-control.json")),
      ),
      { case: 2 },
    );
  });
  controller.abort(cancelled);
  await Promise.all([rejected, second]);
  assert.deepEqual(order, ["first cleaned up", "second started"]);
  assert.equal(process.env.PI_CODING_AGENT_DIR, original);
});

test("a queued cancelled Pi case never takes ownership and later cases still run", async () => {
  const original = process.env.PI_CODING_AGENT_DIR;
  const controller = new AbortController();
  controller.abort(new Error("Already cancelled"));
  let ran = false;
  await assert.rejects(
    withPiTestContext(() => {
      ran = true;
    }, controller.signal),
    /Already cancelled/,
  );
  assert.equal(ran, false);
  await withPiTestContext(async () => {
    assert.notEqual(process.env.PI_CODING_AGENT_DIR, original);
    assert.deepEqual(
      JSON.parse(
        await fs.readFile(
          path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
        ),
      ),
      { retry: { enabled: false }, cacheWarming: "off" },
    );
  });
  assert.equal(process.env.PI_CODING_AGENT_DIR, original);
});
