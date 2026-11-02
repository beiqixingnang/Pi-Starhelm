import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { resolveNotificationPolicy } from "../../runtime/notifications.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
async function harness(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-notifications-"));
  let now = 100000,
    idle = true,
    kernel;
  const workers = [],
    wakes = [];
  const make = () => {
    const value = new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "notifications",
      now: () => now,
      isLeadIdle: () => idle,
      wake(wake) {
        wakes.push(wake);
        idle = false;
      },
      workerFactory: async (assignment, signal) => {
        let resolve;
        const result = new Promise((r) => (resolve = r));
        const worker = {
          assignment,
          result,
          resolve,
          deliveries: [],
          async deliver(message) {
            this.deliveries.push(message);
          },
          async stop() {
            resolve({ ok: false, text: "stopped", processState: "stopped" });
          },
        };
        signal.addEventListener("abort", worker.stop, { once: true });
        workers.push(worker);
        return worker;
      },
    });
    value.start(false);
    return value;
  };
  kernel = make();
  const h = {
    get kernel() {
      return kernel;
    },
    workers,
    wakes,
    idle(value = true) {
      idle = value;
    },
    advance(ms) {
      now += ms;
    },
    add(name, allow = []) {
      return kernel.addMember({
        name,
        role: name,
        thinkingLevel: "off",
        temporary: false,
        allow,
        workspace: {
          root: directory,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
      });
    },
    async reload() {
      await kernel.close();
      kernel = make();
    },
    async settleWake() {
      const wake = wakes.at(-1);
      kernel.leadStarted(wake);
      kernel.includeWake(wake.batchId);
      kernel.leadMessage(false, 1);
      kernel.leadSettled();
      idle = true;
    },
  };
  try {
    await run(h);
  } finally {
    await kernel.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
const claim = [
  {
    criterion: 1,
    source: "statement",
    summary: "Concrete verification of this criterion",
  },
];

test("notification defaults preserve legacy wake behavior and invalid edits are rejected", () => {
  assert.deepEqual(resolveNotificationPolicy(), {
    taskSuccess: true,
    taskFailure: true,
    taskBatchSettled: false,
    goalReadyLevels: [],
    goalAcceptedLevels: [],
  });
  assert.deepEqual(
    resolveNotificationPolicy({ goalReadyLevels: [3, 2, 2] }).goalReadyLevels,
    [2, 3],
  );
  for (const patch of [
    { taskSuccess: "false" },
    { taskFailure: null },
    { taskBatchSettled: "true" },
    { goalReadyLevels: [0] },
    { goalAcceptedLevels: [13] },
    { goalReadyLevels: [1.5] },
  ])
    assert.throws(() => resolveNotificationPolicy(patch));
});

test("success can stay quiet while failure wakes; the failure digest includes retained successful results", () =>
  harness(async (h) => {
    h.add("success");
    h.add("failure");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: true });
    const success = h.kernel.dispatch("success", "Finish quietly");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "SAVED_SUCCESS",
      processState: "stopped",
    });
    await flush();
    h.advance(5000);
    await h.kernel.tick();
    assert.equal(
      h.wakes.length,
      0,
      "no synthetic continuation bypasses a quiet result",
    );
    assert.equal(
      h.kernel.store.deliveries("lead").find((d) => d.taskId === success.id)
        .state,
      "pending",
    );
    h.kernel.dispatch("failure", "Report a failure");
    await flush();
    h.workers[1].resolve({
      ok: false,
      text: "FAILED_TASK",
      error: "Business task failed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /FAILED_TASK/);
    assert.match(h.wakes[0].content, /SAVED_SUCCESS/);
  }));

test("failure can stay quiet while success wakes, and quiet failures cannot crowd the triggering success out", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: true, taskFailure: false });
    h.kernel.setGoal("Independent failure/success preferences");
    for (let i = 0; i < 10; i++)
      h.kernel.delivery({
        key: "failure-" + i,
        taskId: "fixture-" + i,
        from: "worker",
        to: "lead",
        kind: "failure",
        summary: "quiet failure " + i,
      });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.kernel.dispatch("worker", "Success must trigger");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "SUCCESS_TRIGGER",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /SUCCESS_TRIGGER/);
    assert.equal(
      h.kernel.validWake(h.wakes[0].batchId, h.wakes[0].generation),
      true,
    );
  }));

test("quiet results are retained for the unchanged scheduled report and policy survives reload", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    const task = h.kernel.dispatch("worker", "Wait for the report");
    await flush();
    const nextReportAt = h.kernel.snapshot().nextReportAt;
    h.workers[0].resolve({
      ok: true,
      text: "REPORT_ONLY_RECEIPT",
      processState: "stopped",
    });
    await flush();
    await h.reload();
    assert.equal(h.kernel.notificationPolicy().taskSuccess, false);
    assert.equal(h.kernel.snapshot().nextReportAt, nextReportAt);
    h.advance(3599999);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.advance(1);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Scheduled progress/);
    assert.match(h.wakes[0].content, /REPORT_ONLY_RECEIPT/);
    assert.ok(h.kernel.store.task(task.id).resultPath);
  }));

test("second-level batch readiness waits for all required leaves, wakes once and never accepts the goal", () =>
  harness(async (h) => {
    const nodes = h.kernel.planGoals([
      { key: "root", objective: "Main goal", criteria: ["Stage accepted"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Stage two",
        criteria: ["Leaves accepted"],
      },
      {
        key: "one",
        parentId: "stage",
        objective: "File one",
        criteria: ["Verified"],
      },
      {
        key: "two",
        parentId: "stage",
        objective: "File two",
        criteria: ["Verified"],
      },
    ]);
    const [root, stage, one, two] = nodes;
    h.add("one");
    h.add("two");
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      taskFailure: true,
      goalReadyLevels: [2],
    });
    h.kernel.dispatch("one", "File one work", { goalId: one.id });
    h.kernel.dispatch("two", "File two work", { goalId: two.id });
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "ONE_DONE",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    h.workers[1].resolve({
      ok: true,
      text: "TWO_DONE",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Level 2 execution batch settled/);
    assert.match(h.wakes[0].content, /does not accept/);
    assert.equal(h.kernel.goals.node(stage.id).state, "planned");
    assert.equal(h.kernel.goals.node(root.id).state, "planned");
    const ready = h.kernel.store
      .deliveries("lead")
      .filter((d) => d.kind === "goal");
    assert.equal(ready.length, 1);
    assert.equal(ready[0].goalId, stage.id);
    await h.settleWake();
    h.kernel.acceptGoal(one.id, claim, 0);
    h.kernel.acceptGoal(two.id, claim, 0);
    await h.kernel.tick();
    assert.equal(
      h.kernel.store.deliveries("lead").filter((d) => d.kind === "goal").length,
      1,
      "leaf acceptance does not duplicate a batch-ready event",
    );
  }));

test("accepted-level notifications are exact, idempotent and stale goal notifications are fenced", () =>
  harness(async (h) => {
    h.idle(false);
    const [root, stage, leaf] = h.kernel.planGoals([
      { key: "root", objective: "Root", criteria: ["Accepted stage"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Second-level accepted stage",
        criteria: ["Accepted leaf"],
      },
      {
        parentId: "stage",
        objective: "Third-level leaf",
        criteria: ["Verified"],
      },
    ]);
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      goalAcceptedLevels: [2],
    });
    h.kernel.acceptGoal(leaf.id, claim, 0);
    assert.equal(h.kernel.store.deliveries("lead").length, 0);
    const accepted = h.kernel.acceptGoal(stage.id, claim, 0);
    h.kernel.acceptGoal(stage.id, claim, 0);
    assert.equal(h.kernel.store.deliveries("lead").length, 1);
    assert.equal(
      h.kernel.store.deliveries("lead")[0].key,
      "goal-accepted:" + accepted.id,
    );
    h.kernel.editGoal(
      stage.id,
      { state: "planned", reason: "Updated stage requirements" },
      0,
    );
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "superseded");
    assert.equal(h.kernel.store.mission().id, root.id);
  }));

test("quiet task results still resume a waiting parent and direct peer notes do not trigger the lead", () =>
  harness(async (h) => {
    h.add("parent", ["child"]);
    h.add("child");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    const parentTask = h.kernel.dispatch("parent", "Review the child's work");
    await flush();
    const token = h.workers[0].assignment.token;
    h.kernel.memberRequest(token, {
      id: "child",
      op: "message",
      to: "child",
      operation: "assign",
      message: "Child implementation",
    });
    h.kernel.memberRequest(token, { id: "wait", op: "wait" });
    h.workers[0].resolve({
      ok: true,
      text: "waiting",
      processState: "stopped",
    });
    await flush();
    h.workers[1].resolve({
      ok: true,
      text: "CHILD_RECEIPT",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 3);
    assert.equal(h.workers[2].assignment.task.id, parentTask.id);
    assert.match(h.workers[2].assignment.prompt, /CHILD_RECEIPT/);
    assert.equal(h.wakes.length, 0);
  }));

test("policy changes fence a not-yet-started wake and preserve explicit decision notifications", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "Complete a task");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "queued result",
      processState: "stopped",
    });
    await flush();
    const old = h.wakes[0];
    assert.ok(old);
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    assert.equal(h.kernel.validWake(old.batchId, old.generation), false);
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    h.kernel.delivery({
      key: "authorization",
      from: "worker",
      to: "lead",
      kind: "decision",
      summary: "Need explicit permission for deployment",
    });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    assert.match(h.wakes[1].content, /explicit permission/);
  }));

test("a failed stage stays unready until its explicit retry succeeds", () =>
  harness(async (h) => {
    const [, stage, leaf] = h.kernel.planGoals([
      { key: "root", objective: "Root retry", criteria: ["Stage accepted"] },
      {
        key: "stage",
        parentId: "root",
        objective: "Retry stage",
        criteria: ["Leaf done"],
      },
      { parentId: "stage", objective: "Retry leaf", criteria: ["Verified"] },
    ]);
    h.add("worker");
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      taskFailure: false,
      goalReadyLevels: [2],
    });
    const original = h.kernel.dispatch("worker", "Explicit retry fixture", {
      goalId: leaf.id,
    });
    await flush();
    h.workers[0].resolve({
      ok: false,
      text: "Failed attempt",
      error: "Fixture failure",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    h.kernel.resumeTask(original.id);
    await flush();
    h.workers[1].resolve({
      ok: true,
      text: "Retry verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.equal(
      h.kernel.store.deliveries("lead").find((d) => d.kind === "goal").goalId,
      stage.id,
    );
  }));

test("main-goal acceptance can notify after completion without reopening the mission", () =>
  harness(async (h) => {
    const root = h.kernel.setGoal("Main acceptance notification", ["Verified"]);
    h.kernel.setNotificationPolicy({
      taskSuccess: false,
      goalAcceptedLevels: [1],
    });
    h.kernel.complete([
      { criterion: 1, evidence: "Verified outcome with concrete evidence" },
    ]);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Level 1 goal accepted/);
    assert.equal(h.kernel.store.mission().status, "complete");
    assert.equal(h.kernel.goals.node(root.id).state, "accepted");
  }));

test("quiet task receipts do not suppress independent runtime recovery probes", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    h.kernel.dispatch("worker", "Retain this success during recovery");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "QUIET_RECOVERY_RECEIPT",
      processState: "stopped",
    });
    await flush();
    h.kernel.leadStarted();
    h.kernel.leadMessage(true, 0, "Upstream temporarily unavailable");
    h.kernel.leadSettled();
    h.advance(600000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Runtime recovery probe/);
    assert.match(h.wakes[0].content, /QUIET_RECOVERY_RECEIPT/);
  }));

const quietBatch = {
  taskSuccess: false,
  taskFailure: false,
  taskBatchSettled: true,
};
const done = (worker, text = "SAVED_RECEIPT") =>
  worker.resolve({ ok: true, text, processState: "stopped" });
const batchDeliveries = (h) =>
  h.kernel.store.deliveries("lead").filter((d) => d.kind === "batch");

test("switching main goals preserves a pending batch for its original mission", () =>
  harness(async (h) => {
    h.idle(false);
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    const first = h.kernel.setGoal("First main goal", ["Inspect its artifact"]);
    const [second] = h.kernel.planGoals([
      { objective: "Second main goal", criteria: ["Separate acceptance"] },
    ]);
    h.kernel.dispatch("worker", "Write first-goal artifact");
    await flush();
    done(h.workers[0]);
    await flush();
    h.kernel.leadStarted();
    h.kernel.includeCollected(
      h.kernel.store
        .deliveries("lead")
        .filter((d) => d.kind === "result")
        .map((d) => d.id),
    );
    h.kernel.leadMessage(false, 1);
    h.kernel.leadSettled();
    h.kernel.activateGoal(second.id);
    await h.kernel.tick();
    assert.equal(batchDeliveries(h)[0].state, "pending");
    assert.equal(h.wakes.length, 0);
    h.kernel.activateGoal(first.id);
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, new RegExp(first.id));
  }));

test("a main-goal revision supersedes a stale batch without accepting revised work", () =>
  harness(async (h) => {
    h.idle(false);
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("worker", "Implement the initial requirements");
    await flush();
    done(h.workers[0]);
    await flush();
    h.kernel.updateGoal("Revised requirements", ["New evidence required"]);
    h.idle();
    await h.kernel.tick();
    assert.equal(batchDeliveries(h)[0].state, "superseded");
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.mission().status, "active");
  }));

test("quiet parallel work wakes once at batch settlement without changing hourly reports or strict reminders", () =>
  harness(async (h) => {
    h.add("one");
    h.add("two");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.setGoal("Review this execution batch", ["Verify both artifacts"]);
    const reportAt = h.kernel.snapshot().nextReportAt;
    const schedule = h.kernel.addSchedule(
      "Strict compilation check",
      "Inspect the independent build",
      1900000,
      1800000,
    );
    h.kernel.dispatch("one", "Write first artifact");
    h.kernel.dispatch("two", "Write second artifact");
    await flush();
    done(h.workers[0], "FIRST_ARTIFACT");
    await flush();
    assert.equal(h.wakes.length, 0);
    done(h.workers[1], "SECOND_ARTIFACT");
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Execution batch settled/);
    assert.match(h.wakes[0].content, /FIRST_ARTIFACT/);
    assert.match(h.wakes[0].content, /SECOND_ARTIFACT/);
    assert.match(h.wakes[0].content, /not goal acceptance/);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.snapshot().nextReportAt, reportAt);
    assert.equal(h.kernel.store.schedule(schedule.id).nextAt, 1900000);
    await h.settleWake();
    // Keep the lead busy so only the durable due events, rather than its
    // unrelated mission continuation loop, are inspected here.
    h.idle(false);
    h.advance(1799999);
    await h.kernel.tick();
    assert.equal(
      h.kernel.store
        .deliveries("lead")
        .some((d) => d.scheduleId === schedule.id),
      false,
    );
    h.advance(1);
    await h.kernel.tick();
    assert.equal(
      h.kernel.store
        .deliveries("lead")
        .filter((d) => d.scheduleId === schedule.id).length,
      1,
    );
    assert.equal(h.kernel.store.schedule(schedule.id).nextAt, 3700000);
    assert.equal(h.kernel.snapshot().nextReportAt, reportAt);
    assert.equal(batchDeliveries(h).length, 1);
  }));

test("batch notifications are opt-in, can attach during execution and never replay idle history", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy({ taskSuccess: false, taskFailure: false });
    h.kernel.dispatch("worker", "Old round");
    await flush();
    done(h.workers[0]);
    await flush();
    h.kernel.setNotificationPolicy({ taskBatchSettled: true });
    await h.kernel.tick();
    assert.equal(batchDeliveries(h).length, 0);
    h.kernel.setNotificationPolicy({ taskBatchSettled: false });
    h.kernel.dispatch("worker", "Current round");
    await flush();
    h.kernel.setNotificationPolicy({ taskBatchSettled: true });
    done(h.workers[1]);
    await flush();
    assert.equal(batchDeliveries(h).length, 1);
    assert.equal(h.wakes.length, 1);
  }));

test("queued dependencies prevent premature batch settlement", () =>
  harness(async (h) => {
    h.add("first");
    h.add("second");
    h.kernel.setNotificationPolicy(quietBatch);
    const first = h.kernel.dispatch("first", "Build dependency");
    h.kernel.dispatch("second", "Use dependency", { dependsOn: first.id });
    await flush();
    assert.equal(h.workers.length, 1);
    done(h.workers[0]);
    await flush();
    assert.equal(h.workers.length, 2);
    assert.equal(batchDeliveries(h).length, 0);
    done(h.workers[1]);
    await flush();
    assert.equal(batchDeliveries(h).length, 1);
  }));

test("batch settlement includes descendants and the parent's final review", () =>
  harness(async (h) => {
    h.add("parent", ["child"]);
    h.add("child");
    h.kernel.setNotificationPolicy(quietBatch);
    const parent = h.kernel.dispatch(
      "parent",
      "Implement and review descendant",
    );
    await flush();
    const token = h.workers[0].assignment.token;
    h.kernel.memberRequest(token, {
      id: "assign",
      op: "message",
      to: "child",
      operation: "assign",
      message: "Implement child",
    });
    h.kernel.memberRequest(token, { id: "wait", op: "wait" });
    done(h.workers[0]);
    await flush();
    done(h.workers[1], "CHILD_IMPLEMENTED");
    await flush();
    assert.equal(h.workers[2].assignment.task.id, parent.id);
    assert.equal(h.kernel.store.task(parent.id).phase, "review");
    assert.equal(batchDeliveries(h).length, 0);
    done(h.workers[2], "PARENT_REVIEWED");
    await flush();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /PARENT_REVIEWED/);
  }));

test("settled failures and cancellations report their actual outcomes without accepting goals", () =>
  harness(async (h) => {
    h.add("failure");
    h.add("cancelled");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("failure", "Fail this attempt");
    const cancelled = h.kernel.dispatch("cancelled", "Cancel this attempt");
    await flush();
    h.workers[0].resolve({
      ok: false,
      text: "FAILURE_EVIDENCE",
      error: "Compilation failed",
      processState: "stopped",
    });
    await flush();
    assert.equal(batchDeliveries(h).length, 0);
    await h.kernel.cancelTask(cancelled.id, "Explicit test cancellation");
    await flush();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /"failed":1/);
    assert.match(h.wakes[0].content, /"cancelled":1/);
    assert.equal(h.kernel.store.mission().status, "active");
  }));

test("unknown process state blocks batch settlement until explicit reconciliation", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    const task = h.kernel.dispatch("worker", "Retain uncertain process");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "Process uncertain",
      processState: "unknown",
    });
    await flush();
    assert.equal(batchDeliveries(h).length, 0);
    h.kernel.acknowledgeProcess(task.id);
    await h.kernel.tick();
    assert.equal(batchDeliveries(h).length, 1);
  }));

test("registered external builds keep strict checks and suppress batch readiness", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("worker", "Launch an external build and hand off");
    await flush();
    const wait = h.kernel.waitExternal(
      "Independent compiler still running",
      300000,
    );
    const reminder = h.kernel.addSchedule(
      "Strict compiler check",
      "Inspect external build",
      101000,
      1000,
    );
    done(h.workers[0]);
    await flush();
    assert.equal(batchDeliveries(h).length, 0);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Strict compiler check/);
    assert.equal(h.kernel.store.schedule(reminder.id).nextAt, 102000);
    assert.equal(h.kernel.store.mission().externalWait.id, wait.id);
    assert.equal(batchDeliveries(h).length, 0);
    h.kernel.signalExternal(wait.id, wait.token);
    await h.kernel.tick();
    assert.equal(batchDeliveries(h).length, 1);
    assert.equal(h.kernel.store.schedule(reminder.id).nextAt, 102000);
  }));

test("user pause prevents a settled batch from waking or restarting work", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("worker", "User will pause this work");
    await flush();
    await h.kernel.userControl("pause");
    await flush();
    assert.equal(h.kernel.store.mission().status, "paused");
    assert.equal(batchDeliveries(h).length, 0);
    assert.equal(h.wakes.length, 0);
    assert.equal(h.workers.length, 1);
  }));

test("pending batch notifications persist through reload and consumed rounds do not repeat", () =>
  harness(async (h) => {
    h.idle(false);
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("worker", "One durable execution round");
    await flush();
    done(h.workers[0]);
    await flush();
    assert.equal(h.wakes.length, 0);
    const batchId = batchDeliveries(h)[0].taskBatchId;
    await h.reload();
    h.idle();
    await h.kernel.tick();
    assert.equal(h.kernel.notificationPolicy().taskBatchSettled, true);
    assert.equal(h.wakes.length, 1);
    assert.equal(batchDeliveries(h)[0].taskBatchId, batchId);
    await h.settleWake();
    await h.reload();
    await h.kernel.tick();
    assert.equal(batchDeliveries(h).length, 1);
    assert.equal(h.wakes.length, 1);
    h.kernel.dispatch("worker", "A new round");
    await flush();
    done(h.workers[1]);
    await flush();
    assert.equal(batchDeliveries(h).length, 2);
    assert.ok(batchDeliveries(h).some((d) => d.taskBatchId !== batchId));
    assert.equal(h.wakes.length, 2);
  }));

test("new work and disabling the batch policy invalidate not-yet-started batch wakes", () =>
  harness(async (h) => {
    h.add("worker");
    h.kernel.setNotificationPolicy(quietBatch);
    h.kernel.dispatch("worker", "First round");
    await flush();
    done(h.workers[0]);
    await flush();
    const old = h.wakes[0];
    assert.equal(h.kernel.validWake(old.batchId, old.generation), true);
    h.kernel.leadStarted();
    h.kernel.dispatch("worker", "New approved work");
    await flush();
    assert.equal(h.kernel.validWake(old.batchId, old.generation), false);
    assert.equal(batchDeliveries(h)[0].state, "superseded");
    h.kernel.leadMessage(false, 1);
    h.kernel.leadSettled();
    h.idle();
    done(h.workers[1]);
    await flush();
    const current = h.wakes.at(-1);
    assert.equal(h.kernel.validWake(current.batchId, current.generation), true);
    h.kernel.setNotificationPolicy({ taskBatchSettled: false });
    assert.equal(
      h.kernel.validWake(current.batchId, current.generation),
      false,
    );
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 2);
    h.kernel.setNotificationPolicy({ taskBatchSettled: true });
    await h.kernel.tick();
    assert.equal(
      h.wakes.length,
      2,
      "re-enabling while idle does not resurrect an old round",
    );
  }));
