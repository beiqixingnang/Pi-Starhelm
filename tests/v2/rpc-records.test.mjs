import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { rpcRecords } from "../../runtime/rpc-records.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionKernel } from "../../runtime/kernel.ts";
import { createWorkerFactory, writeRpcLine } from "../../runtime/rpc-worker.ts";

test("RPC diagnostics reject nested/spoofed types and preserve LF record indices and incomplete EOF", async () => {
  for (const prefix of [
    '{"nested":{"type":"agent_end"},"body":"',
    '{"type":"SECRET_TOKEN","body":"',
    " ".repeat(4096) + '{"type":"response","body":"',
  ]) {
    await assert.rejects(
      async () => {
        for await (const _ of rpcRecords(
          Readable.from([
            '\n{"type":"agent_end"}\n',
            prefix,
            "x".repeat(9000),
            '"}\n',
          ]),
          8192,
        )) {
        }
      },
      (e) => {
        assert.equal(e.diagnostic.eventType, "unknown");
        assert.equal(e.diagnostic.recordIndex, 3);
        assert.doesNotMatch(e.message, /SECRET_TOKEN|nested|body/);
        return true;
      },
    );
  }
  await assert.rejects(
    async () => {
      for await (const _ of rpcRecords(
        Readable.from(['{"ty', 'pe":"agent_settled"}']),
        8192,
      )) {
      }
    },
    (e) => {
      assert.deepEqual(e.diagnostic, {
        code: "RPC_RECORD_INCOMPLETE",
        eventType: "agent_settled",
        observedBytesLowerBound: 24,
        limitBytes: 8192,
        recordIndex: 1,
      });
      return true;
    },
  );
});

test(
  "a real RPC child fails on oversized canonical output and the task retains its bounded diagnostic through reload",
  { timeout: 20000 },
  async () => {
    const directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "rpc-diagnostic-")),
    );
    const cli = path.join(directory, "offline-worker.mjs");
    // This subprocess speaks the Pi control protocol without contacting a provider.
    fs.writeFileSync(
      cli,
      `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n');
 if(r.type==='prompt'){
  process.stdout.write('{"type":"agent_start"}\\n{"type":"message_end","body":"SECRET-never-in-receipt-');
  for(let i=0;i<140;i++)process.stdout.write('x'.repeat(65536));
  process.stdout.write('"}\\n{"type":"agent_settled","aborted":false}\\n');
 }
});`,
    );
    const make = () =>
      new MissionKernel({
        directory,
        cwd: directory,
        sessionId: "diag",
        isLeadIdle: () => false,
        wake: () => {},
        workerFactory: createWorkerFactory(
          cli,
          path.resolve("extensions/mission-control/member.ts"),
        ),
      });
    let kernel = make();
    kernel.start(false);
    try {
      kernel.setGoal("Isolated canonical record fault");
      kernel.addMember({
        name: "reader",
        role: "Synthetic RPC child",
        thinkingLevel: "off",
        temporary: false,
        allow: [],
        workspace: {
          root: directory,
          access: "read-only",
          execution: "files",
          extraReadRoots: [],
        },
      });
      const task = kernel.dispatch("reader", "Emit synthetic oversized record");
      const deadline = Date.now() + 15000;
      while (
        !kernel.store.task(task.id)?.protocolDiagnostic &&
        Date.now() < deadline
      )
        await new Promise((r) => setTimeout(r, 20));
      const failed = kernel.store.task(task.id);
      assert.equal(failed.state, "failed");
      assert.equal(failed.processState, "stopped");
      assert.equal(failed.protocolDiagnostic.code, "RPC_RECORD_TOO_LARGE");
      assert.equal(failed.protocolDiagnostic.eventType, "message_end");
      assert.equal(failed.protocolDiagnostic.limitBytes, 8 * 1024 * 1024);
      assert.ok(
        failed.protocolDiagnostic.observedBytesLowerBound > 8 * 1024 * 1024,
      );
      assert.doesNotMatch(failed.error, /SECRET-never/);
      await kernel.close();
      kernel = make();
      kernel.start(false);
      assert.deepEqual(
        kernel.store.task(task.id).protocolDiagnostic,
        failed.protocolDiagnostic,
      );
      assert.equal(kernel.store.task(task.id).state, "failed");
    } finally {
      await kernel.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("canonical size diagnostics identify top-level type, actual limit and observed lower bound without content", async () => {
  for (const type of ["message_end", "response", "agent_settled"]) {
    const prefix = `{"type":"${type}","body":"SECRET-sk-DoNotExpose-PRIVATE_REASONING-`;
    await assert.rejects(
      async () => {
        for await (const _ of rpcRecords(
          Readable.from([prefix, "x".repeat(9000), '"}\n']),
          8192,
        )) {
        }
      },
      (e) => {
        assert.equal(e.diagnostic.code, "RPC_RECORD_TOO_LARGE");
        assert.equal(e.diagnostic.eventType, type);
        assert.equal(e.diagnostic.limitBytes, 8192);
        assert.equal(e.diagnostic.recordIndex, 1);
        assert.ok(e.diagnostic.observedBytesLowerBound > 8192);
        assert.doesNotMatch(e.message, /SECRET|sk-|PRIVATE_REASONING|8 MiB/);
        return true;
      },
    );
  }
});

test("oversized cumulative snapshots drain across arbitrary chunks before canonical settlement", async () => {
  const chunk = Buffer.from("synthetic public source ".repeat(4096));
  async function* source() {
    yield '{"type":"agent_start"}\n{"ty';
    yield 'pe":"agent_end","messages":["';
    for (let i = 0; i < 1024; i++) yield chunk;
    yield '"]}\n{"type":"turn_end","message":"';
    for (let i = 0; i < 120; i++) yield chunk;
    yield '"}\r\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"PUBLIC 中文\u2028result"}]}}\n{"type":"agent_settled","aborted":false}\n';
  }
  const records = [];
  for await (const line of rpcRecords(Readable.from(source())))
    records.push(JSON.parse(line));
  assert.deepEqual(
    records.map((r) => r.type),
    ["agent_start", "message_end", "agent_settled"],
  );
  assert.equal(records[1].message.content[0].text, "PUBLIC 中文\u2028result");
});
test("large canonical messages still fail visibly; embedded event names cannot bypass limits", async () => {
  for (const prefix of [
    '{"type":"message_end","text":"',
    '{"type":"response","text":"',
    '{"text":"agent_end',
  ]) {
    await assert.rejects(async () => {
      for await (const line of rpcRecords(
        Readable.from([prefix, "x".repeat(9000), '"}\n']),
        8192,
      )) {
      }
    }, /canonical RPC record/);
  }
  await assert.rejects(async () => {
    for await (const line of rpcRecords(
      Readable.from(['{"type":"agent_settled"}']),
    )) {
    }
  }, /incomplete/);
  await assert.rejects(async () => {
    for await (const line of rpcRecords(
      Readable.from(['{"type":"agent_end","messages": [']),
    )) {
    }
  }, /incomplete/);
});

test(
  "worker traces distinguish RPC, prompt, model-turn and first-response failures",
  { timeout: 30000 },
  async () => {
    const directory = fs.realpathSync.native(
      fs.mkdtempSync(path.join(os.tmpdir(), "rpc-worker-trace-")),
    );
    const cli = path.join(directory, "staged-worker.mjs");
    fs.writeFileSync(
      cli,
      `import readline from 'node:readline';
const sessionArg=process.argv.indexOf('--session-id');
const mode=sessionArg>=0?process.argv[sessionArg+1]:'';
const send=(value,done)=>process.stdout.write(JSON.stringify(value)+'\\n',done);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 if(request.type==='get_state'){
  if(mode==='missing-session')send({type:'response',id:request.id,success:false,error:'Session not found'});
  else send({type:'response',id:request.id,success:true,data:{sessionId:mode}},()=>{
   if(mode==='worker-exit'){process.stdin.destroy();setTimeout(()=>process.exit(0),100);}
  });
 } else if(request.type==='prompt'){
  send({type:'response',id:request.id,success:true,data:{disposition:'started'}});
  if(mode==='model-turn-hang')send({type:'agent_start'});
  if(mode==='model-turn-hang')send({type:'turn_start'});
 } else if(request.type==='abort'){
  send({type:'response',id:request.id,success:true},()=>process.exit(0));
 }
});`,
    );
    for (const scenario of [
      {
        mode: "missing-session",
        timeoutMs: 0,
        error: /Session not found/,
        required: ["process_spawned"],
        absent: ["rpc_ready", "prompt_accepted"],
      },
      {
        mode: "worker-exit",
        timeoutMs: 0,
        error: /Worker (?:process )?exited/,
        required: ["process_spawned"],
        absent: ["prompt_accepted"],
      },
      {
        mode: "prompt-hang",
        timeoutMs: 2000,
        error: /deadline exceeded/,
        required: ["process_spawned", "rpc_ready", "prompt_accepted"],
        absent: ["agent_started", "model_turn_started", "first_response"],
      },
      {
        mode: "model-turn-hang",
        timeoutMs: 2000,
        error: /deadline exceeded/,
        required: [
          "process_spawned",
          "rpc_ready",
          "prompt_accepted",
          "agent_started",
          "model_turn_started",
        ],
        absent: ["first_response", "first_text"],
      },
    ]) {
      const makeKernel = () =>
        new MissionKernel({
          directory,
          cwd: directory,
          sessionId: "trace",
          isLeadIdle: () => false,
          wake: () => {},
          workerFactory: createWorkerFactory(
            cli,
            path.resolve("extensions/mission-control/member.ts"),
          ),
        });
      let kernel = makeKernel();
      kernel.start(false);
      try {
        kernel.setGoal(`Trace ${scenario.mode}`, ["Record the stage boundary"]);
        const member = kernel.addMember({
          name: `worker-${scenario.mode}`,
          role: "RPC trace fixture",
          thinkingLevel: "off",
          temporary: false,
          allow: [],
          workspace: {
            root: directory,
            access: "read-only",
            execution: "files",
            extraReadRoots: [],
          },
        });
        member.sessionId = scenario.mode;
        kernel.store.putMember(member);
        const task = kernel.dispatch(
          member.name,
          "Reply with the fixture result",
          { timeoutMs: scenario.timeoutMs },
        );
        const deadline = Date.now() + 7000;
        let current;
        do {
          current = kernel.store.task(task.id);
          if (["completed", "failed", "cancelled", "interrupted"].includes(current.state))
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        current = kernel.store.task(task.id);
        assert.equal(current.state, "failed", scenario.mode);
        assert.match(current.error, scenario.error, scenario.mode);
        for (const stage of scenario.required)
          assert.equal(typeof current.workerTrace?.[stage], "number", `${scenario.mode}: ${stage}`);
        for (const stage of scenario.absent)
          assert.equal(current.workerTrace?.[stage], undefined, `${scenario.mode}: ${stage}`);
        assert.equal(typeof current.workerTrace?.worker_settled, "number");
      } finally {
        await kernel.close();
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("RPC input write failures retain synchronous and callback EPIPE diagnostics", async () => {
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  await assert.rejects(
    writeRpcLine(
      { write() { throw epipe; } },
      "{}\n",
    ),
    /write EPIPE/,
  );
  await assert.rejects(
    writeRpcLine(
      { write(_line, callback) { callback(epipe); } },
      "{}\n",
    ),
    /write EPIPE/,
  );
});
