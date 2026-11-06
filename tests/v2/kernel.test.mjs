import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MissionKernel } from "../../runtime/kernel.ts";
import { Store } from "../../runtime/store.ts";

const flush = async () => {
  await new Promise(setImmediate);
  await new Promise(setImmediate);
};
function harness() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-v2-kernel-"));
  let now = 100000,
    idle = true,
    changes = 0;
  const wakes = [],
    notices = [],
    workers = [];
  const make = () =>
    new MissionKernel({
      directory,
      cwd: directory,
      sessionId: "fixture",
      now: () => now,
      settings: { progressIntervalMs: 1800000 },
      isLeadIdle: () => idle,
      wake: (w) => {
        wakes.push(w);
        idle = false;
      },
      notify: (n) => notices.push(n),
      onChange: () => changes++,
      workerFactory: async (assignment, signal) => {
        let resolve;
        const result = new Promise((r) => {
          resolve = r;
        });
        const worker = {
          assignment,
          resolve,
          signal,
          stopped: false,
          result,
          deliveries: [],
          async deliver(message) {
            this.deliveries.push(message);
          },
          async stop() {
            this.stopped = true;
            resolve({
              ok: false,
              text: "",
              error: "stopped",
              processState: "stopped",
            });
          },
        };
        signal.addEventListener("abort", () => worker.stop(), { once: true });
        workers.push(worker);
        return worker;
      },
    });
  let kernel = make();
  kernel.start(false);
  const add = (name, allow = []) =>
    kernel.addMember({
      name,
      role: name,
      thinkingLevel: "off",
      workspace: {
        root: directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow,
      temporary: false,
    });
  return {
    directory,
    wakes,
    notices,
    workers,
    add,
    get kernel() {
      return kernel;
    },
    get changes() {
      return changes;
    },
    advance(ms) {
      now += ms;
    },
    idle(v = true) {
      idle = v;
    },
    async restart() {
      await kernel.close();
      kernel = make();
      kernel.start(false);
    },
    async close() {
      await kernel.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function using(fn) {
  const h = harness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test("Escape settles running, queued and descendant work while retaining the paused goal, budgets, artifacts and reminders", () =>
  using(async (h) => {
    h.idle(false);
    h.add("parent", ["child"]);
    h.add("child");
    h.add("queued");
    const parent = h.kernel.dispatch(
      "parent",
      "Review the child after it finishes",
    );
    const mission = h.kernel.store.mission();
    mission.outputTokens = 71;
    mission.turns = 5;
    h.kernel.store.set("mission", mission);
    await flush();
    h.kernel.memberRequest(h.workers[0].assignment.token, {
      id: "child",
      op: "message",
      to: "child",
      operation: "assign",
      message: "Implement an isolated child",
    });
    h.kernel.dispatch("queued", "Wait for the parent", {
      dependsOn: parent.id,
    });
    await flush();
    const reminder = h.kernel.addSchedule(
      "Strict compiler monitor",
      "Inspect the existing producer",
      110000,
      10000,
    );
    const artifact = h.kernel.store.artifact(
      "saved-before-escape",
      "result",
      "SAVED_IMPLEMENTATION",
    );
    const reportAt = h.kernel.snapshot().nextReportAt;
    const goalBefore = h.kernel.goals.node(mission.id);
    const members = h.kernel.store.members().map((member) => member.id);
    await h.kernel.interruptByUser();
    const paused = h.kernel.store.mission();
    assert.equal(paused.id, mission.id);
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseSource, "user");
    assert.equal(paused.outputTokens, 71);
    assert.equal(paused.turns, 5);
    assert.equal(paused.archivedAt, undefined);
    assert.deepEqual(h.kernel.goals.node(mission.id), goalBefore);
    assert.deepEqual(
      h.kernel.store.members().map((member) => member.id),
      members,
    );
    assert.equal(fs.readFileSync(artifact, "utf8"), "SAVED_IMPLEMENTATION");
    assert.ok(
      h.kernel.store
        .missionTasks(mission.id)
        .every(
          (task) =>
            task.state === "cancelled" && task.processState === "stopped",
        ),
    );
    assert.equal(
      h.workers.length,
      2,
      "queued work must never launch during cancellation",
    );
    assert.ok(
      h.workers.every((worker) => worker.signal.aborted && worker.stopped),
    );
    assert.equal(h.kernel.store.schedule(reminder.id).nextAt, 110000);
    assert.equal(h.kernel.snapshot().nextReportAt, reportAt);
    h.idle();
    h.advance(3600000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.workers.length, 2);
    await h.restart();
    assert.equal(h.kernel.store.mission().status, "paused");
    assert.equal(h.kernel.snapshot().held, true);
    h.kernel.onHumanInput("How is it going?");
    await h.kernel.tick();
    assert.equal(h.kernel.store.mission().humanPaused, true);
    assert.throws(
      () => h.kernel.resumeGoal(mission.id),
      /user|pause|continue/i,
    );
    h.kernel.resumeGoal(
      mission.id,
      "User explicitly requested continuing",
      0,
      "user",
    );
    assert.equal(h.kernel.store.mission().outputTokens, 71);
    assert.equal(
      h.workers.length,
      2,
      "explicit resume alone must not replay cancelled tasks",
    );
  }));

test("repeated Escape shares cancellation and retains unknown process evidence instead of declaring it stopped", () =>
  using(async (h) => {
    h.idle(false);
    h.add("worker");
    const task = h.kernel.dispatch("worker", "A process takes time to stop");
    await flush();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    h.workers[0].stop = async () => {
      await gate;
      h.workers[0].resolve({
        ok: false,
        text: "Unconfirmed child",
        processState: "unknown",
      });
    };
    const first = h.kernel.interruptByUser();
    const second = h.kernel.interruptByUser();
    assert.equal(first, second);
    assert.equal(h.kernel.store.mission().status, "paused");
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
    assert.throws(
      () => h.kernel.dispatch("worker", "Do not run new work"),
      /unknown|paused/i,
    );
    release();
    await first;
    assert.equal(h.kernel.store.task(task.id).state, "cancelled");
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
    assert.throws(() => h.kernel.resumeTask(task.id), /unknown/i);
    await h.restart();
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
  }));

test("Escape preserves independent decisions and unrelated goal work", () =>
  using(async (h) => {
    h.idle(false);
    h.add("worker");
    const task = h.kernel.dispatch("worker", "Current mission work");
    await flush();
    const other = {
      ...h.kernel.store.task(task.id),
      id: "unrelated",
      missionId: "another-goal",
      state: "queued",
      processState: "not-started",
    };
    h.kernel.store.putTask(other);
    const mission = h.kernel.store.mission();
    mission.decision = {
      id: "business-choice",
      question: "May we publish?",
      taskIds: [task.id],
      revision: 0,
      humanVersion: 0,
      createdAt: 100000,
    };
    mission.blocker = { kind: "budget", reason: "Independent budget limit" };
    h.kernel.store.set("mission", mission);
    await h.kernel.interruptByUser();
    assert.deepEqual(h.kernel.store.mission().decision, mission.decision);
    assert.deepEqual(h.kernel.store.mission().blocker, mission.blocker);
    assert.deepEqual(h.kernel.store.task(other.id), other);
    assert.throws(
      () => h.kernel.resumeGoal(mission.id, "Continue", 0, "user"),
      /independent/i,
    );
  }));

test("recovery guidance leads large status and prompt views without assuming unknown executions stopped", () =>
  using(async (h) => {
    h.idle(false);
    h.add("worker");
    const task = h.kernel.dispatch("worker", "Inspect retained fixture work");
    await flush();
    h.workers[0].resolve({ ok: false, text: "", processState: "unknown" });
    await flush();
    const m = h.kernel.store.mission();
    m.status = "attention";
    m.blocker = {
      kind: "no_progress",
      reason:
        "Three autonomous turns made no task or goal progress. Review /mission status and resume explicitly.",
    };
    m.reason = m.blocker.reason;
    m.objective = "LONG_OBJECTIVE_".repeat(550);
    m.turns = 9;
    m.outputTokens = 13623;
    h.kernel.store.set("mission", m);
    const before = h.kernel.store.task(task.id);
    const prefix = JSON.stringify(h.kernel.snapshot(), null, 2).slice(0, 5000);
    assert.ok(
      prefix.indexOf("recoveryPlan") < prefix.indexOf("LONG_OBJECTIVE_"),
    );
    const plan = h.kernel.snapshot().recoveryPlan;
    assert.equal(plan.state, "process_inspection_required");
    assert.deepEqual(plan.nextCall.arguments.tasks, [
      { taskId: task.id, expectedEpoch: before.epoch },
    ]);
    assert.equal(plan.afterReconcile.tool, "mission_control");
    assert.equal(plan.afterReconcile.arguments.expectedRevision, 0);
    assert.match(plan.nextCall.requiredArgument, /actual stopped-process/);
    const prompt = h.kernel.context();
    assert.ok(
      prompt.indexOf("mission_reconcile") < prompt.indexOf("LONG_OBJECTIVE_"),
    );
    assert.match(prompt.slice(0, 3000), /mission_control/);
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
    assert.equal(h.kernel.store.mission().status, "attention");
    await h.restart();
    const after = h.kernel.store.mission();
    assert.match(after.reason, /mission_control/);
    assert.doesNotMatch(after.reason, /resume explicitly/);
    assert.equal(after.status, "attention");
    assert.equal(after.turns, 9);
    assert.equal(after.outputTokens, 13623);
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
  }));

test("current recovery instructions expose exact revisions but preserve user, budget and unknown holds", () =>
  using(async (h) => {
    const m = h.kernel.setGoal("Approved fixture");
    m.revision = 7;
    m.status = "attention";
    m.blocker = { kind: "no_progress", reason: "review required" };
    h.kernel.store.set("mission", m);
    assert.deepEqual(h.kernel.recoveryPlan().nextCall.arguments, {
      action: "resume",
      goalId: m.id,
      expectedRevision: 7,
    });
    await h.kernel.userControl("pause");
    assert.equal(h.kernel.recoveryPlan().state, "user_control_required");
    assert.equal(h.kernel.recoveryPlan().nextCall, undefined);
    await h.kernel.userControl("resume");
    const held = h.kernel.store.mission();
    held.status = "attention";
    held.blocker = { kind: "budget", reason: "explicit configured limit" };
    h.kernel.store.set("mission", held);
    assert.equal(h.kernel.recoveryPlan().state, "budget_renewal_required");
    held.blocker = { kind: "unknown", reason: "unclassified old hold" };
    h.kernel.store.set("mission", held);
    assert.equal(h.kernel.recoveryPlan().state, "unclassified_hold");
    assert.equal(h.kernel.recoveryPlan().nextCall, undefined);
  }));

test("reconciliation guidance stays bounded while reporting older unknown executions outside the ordinary task view", () =>
  using(async (h) => {
    h.idle(false);
    h.add("worker");
    const t = h.kernel.dispatch("worker", "retained command");
    await flush();
    h.workers[0].resolve({ ok: false, text: "", processState: "unknown" });
    await flush();
    const original = h.kernel.store.task(t.id);
    h.kernel.store.transaction(() => {
      for (let i = 0; i < 1050; i++)
        h.kernel.store.putTask({
          ...original,
          id: `history-${i}`,
          createdAt: original.createdAt + i + 1,
          processState: i < 105 ? "unknown" : "stopped",
        });
    });
    assert.ok(!h.kernel.store.tasks().some((row) => row.id === original.id));
    const plan = h.kernel.recoveryPlan();
    assert.equal(plan.unknownProcessCount, 106);
    assert.equal(plan.nextCall.arguments.tasks.length, 100);
    assert.equal(plan.remainingUnknown, 6);
    assert.equal(plan.afterReconcile.tool, "mission_status");
    assert.equal(plan.nextCall.arguments.tasks[0].taskId, original.id);
    assert.equal(h.kernel.recoveryPlan(5).nextCall.arguments.tasks.length, 5);
  }));

test("lead process reconciliation is atomic, fenced by epochs and idempotent before an explicit retry", () =>
  using(async (h) => {
    h.idle(false);
    h.add("one");
    h.add("two");
    const one = h.kernel.dispatch("one", "original command"),
      two = h.kernel.dispatch("two", "other command");
    await flush();
    for (const worker of h.workers)
      worker.resolve({
        ok: false,
        text: "",
        error: "termination unconfirmed",
        processState: "unknown",
      });
    await flush();
    const requests = [one, two].map((t) => ({
      taskId: t.id,
      expectedEpoch: h.kernel.store.task(t.id).epoch,
    }));
    assert.throws(
      () =>
        h.kernel.reconcileProcesses(
          [requests[0], { ...requests[1], expectedEpoch: 999 }],
          "Host process inventory confirms old workers are absent",
        ),
      /epoch/,
    );
    assert.equal(h.kernel.store.task(one.id).processState, "unknown");
    assert.equal(h.kernel.store.task(two.id).processState, "unknown");
    const receipt = h.kernel.reconcileProcesses(
      requests,
      "Inspected saved receipts and host process inventory; no old workers remain",
    );
    assert.equal(receipt.reconciled.length, 2);
    assert.ok(
      h.kernel
        .reconcileProcesses(requests, "Repeated verified inspection receipt")
        .reconciled.every((r) => r.alreadyStopped),
    );
    const retry = h.kernel.resumeTask(one.id);
    assert.equal(retry.attemptOf, one.id);
    assert.notEqual(retry.id, one.id);
    assert.equal(h.kernel.store.task(one.id).state, "failed");
  }));

test("stop settles activity at user intent while delayed cancellation keeps unknown process evidence and usage", () =>
  using(async (h) => {
    const root = h.kernel.setGoal("Delayed cancellation accounting", [
      "Retain process receipts",
    ]);
    h.add("reader");
    h.kernel.leadStarted();
    const task = h.kernel.dispatch("reader", "Synthetic cancellable work");
    await flush();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    h.workers[0].stop = async () => {
      await gate;
      h.workers[0].resolve({
        ok: false,
        text: "Retained partial output",
        processState: "unknown",
      });
    };
    h.advance(4000);
    const stopping = h.kernel.stopGoal(root.id, "Explicit stop during work");
    await flush();
    const ended = h.kernel.store.get("goalActivityClock:" + root.id);
    assert.equal(ended.state, "ended");
    assert.equal(ended.activeMs, 4000);
    assert.equal(h.kernel.goals.node(root.id).updatedAt, 104000);
    h.advance(20000);
    await h.kernel.tick();
    release();
    await stopping;
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root.id), ended);
    assert.equal(h.kernel.store.task(task.id).goalId, task.goalId);
    await h.restart();
    assert.equal(h.kernel.store.task(task.id).processState, "unknown");
    assert.deepEqual(h.kernel.store.get("goalActivityClock:" + root.id), ended);
  }));

test("archiving an inactive main goal cancels only its task tree and deliveries while the current worker continues", () =>
  using(async (h) => {
    h.idle(false);
    const [current, old] = h.kernel.planGoals([
      { objective: "Current goal", criteria: ["Worker continues"] },
      { objective: "Obsolete goal", criteria: ["Archive old tree"] },
    ]);
    h.add("current-reader");
    const oldMember = h.add("old-reader");
    const task = h.kernel.dispatch("current-reader", "Keep working");
    await flush();
    const previous = {
      ...h.kernel.store.task(task.id),
      id: "old-task",
      missionId: old.id,
      goalId: old.id,
      member: oldMember.name,
      memberId: oldMember.id,
      state: "queued",
      processState: "stopped",
    };
    h.kernel.store.putTask(previous);
    h.kernel.store.putTask({
      ...previous,
      id: "old-child",
      parentId: previous.id,
    });
    h.kernel.store.putTask({
      ...previous,
      id: "old-unknown",
      state: "interrupted",
      processState: "unknown",
    });
    const oldDelivery = h.kernel.delivery({
      key: "old-result",
      taskId: previous.id,
      from: oldMember.name,
      to: "lead",
      kind: "result",
      summary: "Old result",
    });
    const currentDelivery = h.kernel.delivery({
      key: "current-progress",
      taskId: task.id,
      from: "current-reader",
      to: "lead",
      kind: "progress",
      summary: "Current progress",
    });
    await h.kernel.stopGoal(old.id, "Archive obsolete goal");
    assert.equal(h.kernel.store.task(previous.id).state, "cancelled");
    assert.equal(h.kernel.store.task("old-child").state, "cancelled");
    assert.equal(h.kernel.store.task("old-unknown").processState, "unknown");
    assert.equal(
      h.kernel.store.deliveries().find((d) => d.id === oldDelivery.id).state,
      "cancelled",
    );
    assert.deepEqual(
      h.kernel.store.deliveries().find((d) => d.id === currentDelivery.id),
      JSON.parse(JSON.stringify(currentDelivery)),
    );
    assert.equal(h.kernel.store.task(task.id).state, "running");
    assert.equal(h.workers[0].signal.aborted, false);
    assert.equal(h.kernel.store.mission().id, current.id);
    h.workers[0].resolve({
      ok: true,
      text: "Current work completed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(task.id).state, "completed");
  }));

test("delayed goal cancellation cannot clear a newly selected goal or its user pause", () =>
  using(async (h) => {
    h.idle(false);
    const old = h.kernel.setGoal("Stopping old goal");
    h.add("reader");
    h.kernel.dispatch("reader", "Wait for cancellation");
    await flush();
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    h.workers[0].stop = async () => {
      await gate;
      h.workers[0].resolve({ ok: false, text: "", processState: "stopped" });
    };
    const stopping = h.kernel.stopGoal(old.id);
    await flush();
    const current = h.kernel.setGoal("New independent goal");
    h.kernel.pauseGoal(current.id, "User requested pause", 0, "user");
    h.kernel.store.set("escapeHold", true);
    const before = h.kernel.store.mission();
    release();
    await stopping;
    assert.deepEqual(h.kernel.store.mission(), before);
    assert.equal(h.kernel.snapshot().held, true);
    assert.equal(h.kernel.store.get("escapeHold"), true);
    assert.equal(h.kernel.store.savedMission(old.id).status, "stopped");
  }));

test("lead reconciliation rejects a live execution and cancellation cannot fake a stopped unknown process", () =>
  using(async (h) => {
    h.idle(false);
    h.add("one");
    const task = h.kernel.dispatch("one", "work");
    await flush();
    assert.throws(
      () =>
        h.kernel.reconcileProcesses(
          [
            {
              taskId: task.id,
              expectedEpoch: h.kernel.store.task(task.id).epoch,
            },
          ],
          "Verified process stop evidence",
        ),
      /active/,
    );
    h.workers[0].resolve({ ok: false, text: "", processState: "unknown" });
    await flush();
    const old = h.kernel.store.task(task.id);
    old.state = "cancelled";
    h.kernel.store.putTask(old);
    await h.kernel.cancelTask(old.id);
    assert.equal(h.kernel.store.task(old.id).processState, "unknown");
  }));

test("lead no-progress recovery preserves budgets and cannot override user or decision holds", () =>
  using(async (h) => {
    const m = h.kernel.setGoal("Approved work");
    m.status = "attention";
    m.blocker = { kind: "no_progress", reason: "no progress" };
    m.turns = 22;
    m.outputTokens = 400;
    m.emptyTurns = 3;
    h.kernel.store.set("mission", m);
    assert.throws(
      () => h.kernel.resumeProgress("old", 0, "Saved receipts were inspected"),
      /identity/,
    );
    const restored = h.kernel.resumeProgress(
      m.id,
      0,
      "Reconciled interrupted work; continue the next approved step",
    );
    assert.equal(restored.turns, 22);
    assert.equal(restored.outputTokens, 400);
    assert.equal(restored.budgetStartedAt, m.budgetStartedAt);
    assert.equal(restored.status, "active");
    h.kernel.requireDecision("Which target?");
    assert.throws(
      () => h.kernel.resumeProgress(m.id, 0, "Inspected the saved results"),
      /decision/,
    );
    await h.kernel.userControl("pause");
    assert.throws(
      () => h.kernel.resumeProgress(m.id, 0, "Continue the saved results"),
      /User pause/,
    );
  }));

test("model-requested compaction waits for idle and runs only once without inventing a user pause", () =>
  using(async (h) => {
    let compactions = 0;
    h.kernel.options.compact = () => {
      compactions++;
    };
    h.kernel.setGoal("Approved work");
    h.idle(false);
    h.kernel.leadStarted();
    h.kernel.queueCompaction();
    h.kernel.queueCompaction();
    await h.kernel.tick();
    assert.equal(compactions, 0);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    h.idle();
    await h.kernel.tick();
    await h.kernel.tick();
    assert.equal(compactions, 1);
    assert.equal(h.kernel.snapshot().compactionQueued, false);
    assert.equal(h.kernel.snapshot().held, false);
    await h.kernel.userControl("pause");
    assert.throws(() => h.kernel.queueCompaction(), /hold/);
  }));

test("dispatch alone enrolls the mission and completion wakes without Goal or supervisor setup", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.onHumanInput("Continue approved development overnight");
    const task = h.kernel.dispatch("worker", "read the fixture");
    await flush();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.workers.length, 1);
    assert.equal(h.wakes.length, 0);
    h.workers[0].resolve({
      ok: true,
      text: "verified child result",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(task.id).state, "completed");
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /verified child result/);
    assert.equal(
      h.kernel.store.deliveries("lead")[0].state,
      "leased",
      "submission is not observation",
    );
    h.kernel.leadStarted(h.wakes[0]);
    h.kernel.includeWake(h.wakes[0].batchId);
    h.kernel.leadMessage(false, 3);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "observed");
  }));

test("busy lead leaves results durable and does not build Pi follow-up queues", () =>
  using(async (h) => {
    h.add("worker");
    h.idle(false);
    h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "late result",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "pending");
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
  }));

test("answering an intermediate question neither stops the mission nor changes the report schedule", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "long work");
    await flush();
    const initial = h.kernel.snapshot().nextReportAt;
    h.kernel.onHumanInput("What does waiting mean?");
    h.kernel.leadStarted();
    h.kernel.leadMessage(false, 1);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.snapshot().nextReportAt, initial);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
  }));

test("peer dispatch does not bypass the configured thirty-minute progress interval", () =>
  using(async (h) => {
    h.add("supervisor", ["worker"]);
    h.add("worker");
    h.kernel.dispatch("supervisor", "delegate");
    await flush();
    const parent = h.workers[0].assignment;
    h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "assign-1",
      operation: "assign",
      to: "worker",
      message: "child",
    });
    await flush();
    assert.equal(h.workers.length, 2);
    assert.equal(h.wakes.length, 0);
    h.advance(1799000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /Scheduled progress/);
  }));

test("routine member progress is coalesced and never wakes the lead by itself", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "long work");
    await flush();
    const worker = h.workers[0].assignment;
    for (let i = 0; i < 10; i++)
      h.kernel.memberRequest(worker.token, {
        op: "message",
        id: "progress-" + i,
        to: "lead",
        operation: "note",
        kind: "progress",
        message: "update " + i,
      });
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    const progress = h.kernel.store.deliveries("lead");
    assert.equal(progress.length, 1);
    assert.equal(progress[0].summary, "update 9");
    h.advance(1800000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /update 9/);
  }));

test("supervisor waits without a live process and resumes its same task for descendant review", () =>
  using(async (h) => {
    h.add("supervisor", ["worker"]);
    h.add("worker");
    const root = h.kernel.dispatch("supervisor", "review the child");
    await flush();
    const parent = h.workers[0].assignment;
    const child = h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "child-request",
      operation: "assign",
      to: "worker",
      message: "implement",
    });
    const duplicate = h.kernel.memberRequest(parent.token, {
      op: "message",
      id: "child-request",
      operation: "assign",
      to: "worker",
      message: "implement",
    });
    assert.equal(child.id, duplicate.id);
    h.kernel.memberRequest(parent.token, { op: "wait", id: "wait" });
    h.workers[0].resolve({
      ok: true,
      text: "waiting",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(root.id).state, "waiting");
    assert.equal(h.wakes.length, 0);
    h.workers[1].resolve({
      ok: true,
      text: "receipt: tests passed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.workers.length, 3);
    const review = h.workers[2].assignment;
    assert.equal(review.task.id, root.id);
    assert.equal(review.task.phase, "review");
    assert.equal(review.member.sessionId, parent.member.sessionId);
    assert.match(review.prompt, /receipt: tests passed/);
    h.workers[2].resolve({
      ok: true,
      text: "independently reviewed",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.task(root.id).state, "completed");
    assert.equal(h.wakes.length, 1);
  }));

test("a member blocker immediately wakes the lead and explicit retry creates a new attempt", () =>
  using(async (h) => {
    h.add("worker");
    const original = h.kernel.dispatch(
      "worker",
      "Apply the requested source edit",
    );
    await flush();
    const token = h.workers[0].assignment.token;
    const delivery = h.kernel.memberRequest(token, {
      op: "wait",
      id: "blocked-edit",
      blockedReason:
        "edit matched two occurrences; a unique code range is required",
    });
    assert.equal(delivery.kind, "blocker");
    assert.equal(h.kernel.store.task(original.id).state, "waiting");
    assert.match(
      h.kernel.store.task(original.id).blockedReason,
      /two occurrences/,
    );
    h.workers[0].resolve({
      ok: true,
      text: "blocked",
      processState: "stopped",
    });
    await flush();
    h.idle();
    await h.kernel.tick();
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /unique code range/);
    const retry = h.kernel.resumeTask(original.id);
    assert.notEqual(retry.id, original.id);
    assert.equal(h.kernel.store.task(original.id).state, "cancelled");
    assert.equal(h.kernel.store.task(retry.id).attemptOf, original.id);
  }));

test("a scheduled member progress check requeues the same task without waking the lead", () =>
  using(async (h) => {
    h.add("worker", ["child"]);
    h.add("child");
    const task = h.kernel.dispatch("worker", "Wait for the child result");
    await flush();
    const token = h.workers[0].assignment.token;
    h.kernel.memberRequest(token, {
      op: "message",
      id: "child-task",
      operation: "assign",
      to: "child",
      message: "Produce the pending result",
    });
    const result = h.kernel.memberRequest(token, {
      op: "wait",
      id: "scheduled-check",
      reportAfterMs: 5000,
    });
    assert.equal(result.waiting, true);
    assert.equal(h.kernel.store.task(task.id).state, "waiting");
    h.workers[0].resolve({
      ok: true,
      text: "waiting",
      processState: "stopped",
    });
    await flush();
    h.advance(5000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.task(task.id).state, "running");
    assert.equal(h.workers.length, 3);
    assert.match(h.workers[2].assignment.prompt, /Scheduled progress check/);
  }));

test("directed communication, ancestor-cycle checks and stale execution tokens reject unauthorized work", () =>
  using(async (h) => {
    h.add("reviewer");
    h.add("worker");
    const root = h.kernel.dispatch("reviewer", "review");
    await flush();
    const assignment = h.workers[0].assignment;
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "bad",
          to: "worker",
          message: "escape",
        }),
      /Communication denied/,
    );
    h.kernel.store.putMember({
      ...h.kernel.store.member("reviewer"),
      allow: ["reviewer"],
    });
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "cycle",
          operation: "assign",
          to: "reviewer",
          message: "loop",
        }),
      /cycle/,
    );
    await h.kernel.cancelTask(root.id);
    assert.throws(
      () =>
        h.kernel.memberRequest(assignment.token, {
          op: "message",
          id: "late",
          to: "lead",
          message: "old",
        }),
      /Stale/,
    );
  }));

test("user stop fences late results, retains identity and never resumes through a normal question", () =>
  using(async (h) => {
    h.add("worker");
    const t = h.kernel.dispatch("worker", "long task");
    await flush();
    await h.kernel.userControl("stop");
    h.workers[0].resolve({
      ok: true,
      text: "obsolete success",
      processState: "stopped",
    });
    await flush();
    h.kernel.onHumanInput("What happened?");
    h.advance(100000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.task(t.id).state, "cancelled");
    assert.equal(h.kernel.store.mission().status, "stopped");
    assert.equal(h.wakes.length, 0);
    assert.equal(h.kernel.store.members().length, 1);
  }));

test("restart records interrupted work and delivers recovery instead of replaying commands", () =>
  using(async (h) => {
    h.add("worker");
    const t = h.kernel.dispatch("worker", "side effect");
    await flush();
    await h.restart();
    assert.equal(h.kernel.store.task(t.id).state, "interrupted");
    h.advance(1000);
    await h.kernel.tick();
    assert.equal(h.workers.length, 1);
    assert.equal(h.wakes.length, 1);
    assert.match(h.wakes[0].content, /reconcile|Runtime closed/i);
  }));

test("failed wakes preserve unread results and automatically probe again after a bounded burst", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({ ok: true, text: "result", processState: "stopped" });
    await flush();
    for (let i = 0; i < 4; i++) {
      h.kernel.leadStarted(h.wakes.at(-1));
      h.kernel.leadMessage(true);
      h.kernel.leadSettled();
      h.idle();
      h.advance(600000);
      await h.kernel.tick();
    }
    assert.equal(h.wakes.length, 5);
    assert.equal(h.kernel.store.mission().status, "active");
    assert.equal(h.kernel.snapshot().recovery.phase, "probing");
    assert.ok(
      h.kernel.store.deliveries("lead").some((d) => d.state === "quarantined"),
    );
    h.kernel.leadStarted(h.wakes.at(-1));
    h.kernel.leadMessage(true);
    h.kernel.leadSettled();
    h.idle();
    h.advance(20000);
    await h.kernel.tick();
    assert.equal(h.wakes.length, 5);
  }));

test("reminder occurrence and outbox commit together; missed intervals do not accumulate old reminders", () =>
  using(async (h) => {
    h.kernel.addSchedule("progress", "review", 101000, 1000);
    h.advance(9000);
    await h.kernel.tick();
    const reminders = h.kernel.store.deliveries("lead");
    assert.equal(reminders.length, 1);
    assert.equal(h.kernel.store.schedules()[0].nextAt, 110000);
    await h.kernel.tick();
    assert.equal(h.kernel.store.deliveries("lead").length, 1);
  }));

test("complete cannot hide outstanding work; owner lock prevents two runtime controllers", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.dispatch("worker", "task");
    await flush();
    assert.throws(
      () => h.kernel.complete([{ criterion: 1, evidence: "claimed complete" }]),
      /still/,
    );
    assert.throws(() => new Store(h.directory), /already/);
  }));

test("explicitly collected results are confirmed only after a successful model response", () =>
  using(async (h) => {
    h.add("worker");
    h.idle(false);
    const task = h.kernel.dispatch("worker", "task");
    await flush();
    h.workers[0].resolve({ ok: true, text: "result", processState: "stopped" });
    await flush();
    const delivery = h.kernel.store.deliveries("lead")[0];
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "admitted");
    h.kernel.leadMessage(true);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "pending");
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    assert.equal(h.kernel.store.deliveries("lead")[0].state, "observed");
  }));

test("user report timing persists across restart and an exhausted old mission cannot poison a new objective", () =>
  using(async (h) => {
    h.add("worker");
    h.kernel.setReportInterval(4000000);
    await h.restart();
    assert.equal(h.kernel.settings.progressIntervalMs, 4000000);
    h.kernel.dispatch("worker", "old work");
    await flush();
    await h.kernel.userControl("stop");
    h.kernel.onHumanInput("new objective");
    h.kernel.dispatch("worker", "new work");
    await h.kernel.tick();
    await flush();
    assert.equal(h.kernel.store.mission().status, "active");
    assert.notEqual(
      h.kernel.store.tasks()[0].missionId,
      h.kernel.store.tasks()[1].missionId,
    );
  }));

test("unknown execution cannot be retried until the user reconciles its process state", () =>
  using(async (h) => {
    h.add("worker");
    const task = h.kernel.dispatch("worker", "side effect");
    await flush();
    h.workers[0].resolve({
      ok: false,
      text: "",
      error: "termination unconfirmed",
      processState: "unknown",
    });
    await flush();
    assert.throws(() => h.kernel.resumeTask(task.id), /unknown process state/);
    h.kernel.acknowledgeProcess(task.id);
    const retry = h.kernel.resumeTask(task.id);
    assert.equal(retry.attemptOf, task.id);
  }));

test("notes to a running permitted peer are admitted through steering and confirmed on its successful response", () =>
  using(async (h) => {
    h.add("reviewer", ["worker"]);
    h.add("worker");
    h.kernel.dispatch("reviewer", "review");
    h.kernel.dispatch("worker", "implementation");
    await flush();
    const sender = h.workers.find(
        (w) => w.assignment.member.name === "reviewer",
      ),
      recipient = h.workers.find((w) => w.assignment.member.name === "worker");
    h.kernel.memberRequest(sender.assignment.token, {
      op: "message",
      id: "note-1",
      operation: "note",
      to: "worker",
      kind: "decision",
      message: "Keep the documented signal interface",
    });
    await h.kernel.tick();
    await flush();
    assert.match(recipient.deliveries[0], /documented signal/);
    assert.equal(h.kernel.store.deliveries("worker")[0].state, "leased");
    recipient.resolve({
      ok: true,
      text: "implemented and verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.deliveries("worker")[0].state, "observed");
  }));

test("a decision needs an explicit resolution after a fresh human answer and never overrides a user pause", () =>
  using(async (h) => {
    h.kernel.setGoal("authorized work");
    h.kernel.requireDecision("Which approved target should be used?");
    const id = h.kernel.store.mission().decision.id;
    h.kernel.onHumanInput("What is the progress?");
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    h.kernel.onHumanInput("Use target A");
    h.kernel.resolveDecision(id, "Use target A");
    assert.equal(h.kernel.store.mission().status, "active");
    await h.kernel.userControl("pause");
    h.kernel.onHumanInput("Explain the progress");
    assert.equal(h.kernel.store.mission().status, "paused");
  }));

test("goal update and stop have explicit lifecycle records", () =>
  using(async (h) => {
    const goal = h.kernel.setGoal("old objective", ["old criterion"]);
    const updated = h.kernel.updateGoal(
      "new objective",
      ["new criterion"],
      goal.id,
    );
    assert.equal(updated.id, goal.id);
    assert.equal(updated.revision, 1);
    assert.deepEqual(updated.criteria, ["new criterion"]);
    const stopped = await h.kernel.stopGoal(goal.id, "test cleanup");
    assert.equal(stopped.status, "stopped");
    assert.equal(h.kernel.store.mission(), undefined);
    assert.equal(h.kernel.lifecycleHistory().goals[0].archiveReason, "stopped");
  }));

test("completed goals remain inspectable while temporary subagents leave the active roster", () =>
  using(async (h) => {
    const member = h.kernel.addMember({
      name: "temporary-worker",
      role: "temporary",
      thinkingLevel: "off",
      workspace: {
        root: h.directory,
        access: "read-only",
        execution: "files",
        extraReadRoots: [],
      },
      allow: [],
      temporary: true,
    });
    const task = h.kernel.dispatch(member.name, "finish once");
    await flush();
    h.workers[0].resolve({
      ok: true,
      text: "verified",
      processState: "stopped",
    });
    await flush();
    assert.equal(h.kernel.store.member(member.name), undefined);
    const delivery = h.kernel.store.deliveries("lead")[0];
    h.kernel.leadStarted();
    h.kernel.includeCollected([delivery.id]);
    h.kernel.leadMessage(false);
    h.kernel.leadSettled();
    const completed = h.kernel.complete([
      { criterion: 1, evidence: "verified temporary result" },
    ]);
    assert.equal(completed.status, "complete");
    assert.equal(h.kernel.store.mission().status, "complete");
    assert.equal(h.kernel.store.members().length, 0);
    assert.equal(h.kernel.lifecycleHistory().counts.goal, 1);
    assert.equal(h.kernel.lifecycleHistory().counts.member, 1);
    assert.equal(h.kernel.store.task(task.id).state, "completed");
  }));

test("reminders can be revised, paused and deleted without stale deliveries", () =>
  using(async (h) => {
    const schedule = h.kernel.addSchedule("old", "check old", 101000, 1000);
    const updated = h.kernel.updateSchedule(schedule.id, {
      title: "new",
      prompt: "check new",
      state: "paused",
    });
    assert.equal(updated.title, "new");
    assert.equal(updated.state, "paused");
    h.kernel.updateSchedule(schedule.id, { state: "active", nextAt: 101000 });
    h.advance(1000);
    await h.kernel.tick();
    h.kernel.deleteSchedule(schedule.id);
    assert.equal(h.kernel.store.schedules().length, 0);
    assert.equal(
      h.kernel.store.schedule(schedule.id, true).archiveReason,
      "deleted",
    );
    assert.ok(
      h.kernel.store
        .deliveries("lead")
        .filter((delivery) => delivery.scheduleId === schedule.id)
        .every((delivery) => delivery.state === "cancelled"),
    );
  }));

test("business-only autonomy policy keeps execution choices with the lead and reserves decisions for business boundaries", () =>
  using(async (h) => {
    assert.equal(h.kernel.decisionPolicy(), "business-only");
    h.kernel.setGoal("Approved work", ["Evidence"]);
    assert.throws(
      () =>
        h.kernel.requireDecision(
          "Which command and file layout should I use for the implementation?",
        ),
      /execution choice|approved scope/i,
    );
    const mission = h.kernel.requireDecision(
      "Should this release include the GPU path?",
      [],
      "business",
    );
    assert.equal(mission.status, "waiting_user");
    const decision = mission.decision.id;
    const humanVersion = h.kernel.store.get("humanVersion");
    h.kernel.setDecisionPolicy("business-only");
    h.kernel.setDecisionPolicy("business-only");
    assert.equal(h.kernel.store.mission().decision.id, decision);
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    assert.equal(h.kernel.store.get("humanVersion"), humanVersion);
    assert.equal(
      h.kernel.store.db
        .prepare(
          "SELECT COUNT(*) AS n FROM events WHERE kind='mission.decision-policy'",
        )
        .get().n,
      1,
    );
    assert.throws(
      () => h.kernel.setDecisionPolicy("unrestricted"),
      /Supported/,
    );
    await h.restart();
    assert.equal(h.kernel.decisionPolicy(), "business-only");
    assert.equal(h.kernel.store.mission().decision.id, decision);
    await h.kernel.userControl("pause");
    h.kernel.setDecisionPolicy("business-only");
    assert.equal(h.kernel.store.mission().humanPaused, true);
  }));

test("a new natural-language human delegation resolves the exact decision without an option letter", () =>
  using(async (h) => {
    const m = h.kernel.setGoal(
      "Preserve evidence and finish the approved work",
      ["Verified result"],
    );
    m.turns = 9;
    m.outputTokens = 13623;
    h.kernel.store.set("mission", m);
    const decision = h.kernel.requireDecision(
      "Which approved scope should the lead choose?",
    ).decision.id;
    const answer = "在现有批准范围内由你选择方案并说明依据，保留所有真实证据。";
    assert.throws(
      () => h.kernel.resolveDecision(decision, answer),
      /direct human/,
    );
    h.kernel.onHumanInput(answer);
    assert.equal(h.kernel.store.mission().status, "waiting_user");
    const resolved = h.kernel.resolveDecision(decision, answer);
    assert.equal(resolved.status, "active");
    assert.equal(resolved.decision, undefined);
    assert.equal(resolved.turns, 9);
    assert.equal(resolved.outputTokens, 13623);
    assert.equal(resolved.budgetStartedAt, m.budgetStartedAt);
    assert.match(h.kernel.context(), /goal_submit records pending evidence/);
  }));

test("maintenance refreshes only after a persisted state change", () =>
  using(async (h) => {
    h.kernel.setGoal("Idle refresh fixture", ["No-op ticks stay quiet"]);
    const before = h.changes;
    await h.kernel.tick();
    assert.equal(h.changes, before);
    h.advance(1500);
    await h.kernel.tick();
    assert.ok(h.changes > before);
    assert.ok(
      h.kernel.store
        .deliveries("lead")
        .some((delivery) => delivery.kind === "continue"),
    );
  }));

test("dispatch immediately supersedes an idle continuation notice", () =>
  using(async (h) => {
    h.idle(false);
    h.kernel.setGoal("Continuation race fixture", ["Finish after dispatch"]);
    const mission = h.kernel.store.mission();
    mission.nextContinueAt = 100000;
    h.kernel.store.set("mission", mission);
    await h.kernel.tick();
    const notice = h.kernel
      .store
      .deliveries("lead")
      .find((delivery) => delivery.kind === "continue");
    assert.ok(notice);
    assert.equal(h.kernel.validLeadDelivery(notice), true);
    h.add("worker");
    h.kernel.dispatch("worker", "A new approved task replaced the idle state");
    const stale = h.kernel
      .store
      .deliveries("lead")
      .find((delivery) => delivery.id === notice.id);
    assert.equal(stale.state, "superseded");
    assert.equal(h.kernel.validLeadDelivery(stale), false);
  }));

test("legacy task rows keep their layout and use indexed mission lookup", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mc-legacy-task-index-"));
  const database = new DatabaseSync(path.join(directory, "state.sqlite"));
  database.exec(`
    CREATE TABLE meta(key TEXT PRIMARY KEY,data TEXT NOT NULL);
    INSERT INTO meta VALUES('schema','2');
    CREATE TABLE tasks(id TEXT PRIMARY KEY,member TEXT NOT NULL,parent TEXT,state TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL);
  `);
  const legacy = {
    id: "legacy-task",
    missionId: "legacy-mission",
    memberId: "legacy-member",
    member: "worker",
    state: "completed",
    createdAt: 10,
    phase: "work",
  };
  database
    .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
    .run(legacy.id, legacy.memberId, null, legacy.state, legacy.createdAt, JSON.stringify(legacy));
  const archivedLegacy = {
    ...legacy,
    id: "legacy-archived-task",
    archivedAt: 20,
    createdAt: 20,
  };
  database
    .prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?)")
    .run(archivedLegacy.id, archivedLegacy.memberId, null, archivedLegacy.state, archivedLegacy.createdAt, JSON.stringify(archivedLegacy));
  database.close();
  const store = new Store(directory);
  try {
    assert.equal(store.missionTasks("legacy-mission")[0].id, legacy.id);
    assert.equal(store.taskPage(10).total, 1);
    assert.equal(store.tasks().length, 1);
    assert.equal(store.tasks(false, true).length, 2);
    assert.equal(
      store.db.prepare("PRAGMA table_info(tasks)").all().length,
      8,
    );
    assert.equal(
      store.db.prepare("SELECT mission FROM tasks WHERE id=?").get(legacy.id)
        .mission,
      "legacy-mission",
    );
    assert.equal(
      store.db
        .prepare("SELECT archived FROM tasks WHERE id=?")
        .get(archivedLegacy.id).archived,
      1,
    );
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT data FROM tasks WHERE mission=? ORDER BY created,id",
      )
      .all("legacy-mission");
    assert.match(JSON.stringify(plan), /task_mission_created/);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
