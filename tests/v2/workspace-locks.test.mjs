import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { workspaceLocks } from "../../runtime/workspace-locks.ts";

async function withHolder(run) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "starhelm-lock-probe-")),
  );
  const cwd = path.join(root, "工作 子目录");
  fs.mkdirSync(cwd);
  const child = spawn(
    process.execPath,
    ["-e", "process.stdout.write('READY'); process.stdin.resume()"],
    {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    await once(child.stdout, "data");
    await run({ root, cwd, child });
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test(
  "Windows native cwd probe identifies a real Unicode descendant holder even when CIM is unavailable",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  () =>
    withHolder(async ({ root, cwd, child }) => {
      const script =
        "function Get-CimInstance { throw 'CIM provider intentionally unavailable' }\n" +
        fs.readFileSync(
          new URL("../../runtime/workspace-locks.ps1", import.meta.url),
          "utf8",
        );
      const executable = path.join(
        process.env.SystemRoot,
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      );
      const probe = await new Promise((resolve, reject) => {
        const helper = execFile(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          {
            cwd: os.tmpdir(),
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 256000,
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error)
              reject(
                new Error(
                  `Native lock diagnosis failed: ${stderr || error.message}`,
                ),
              );
            else resolve(JSON.parse(stdout.replace(/^\uFEFF/, "")));
          },
        );
        helper.stdin.end(
          JSON.stringify({
            root: root.toUpperCase(),
            leadPid: process.pid,
            parentPid: process.ppid,
          }),
        );
      });
      assert.equal(probe.supported, true);
      assert.equal(probe.exhaustive, false);
      assert.equal(probe.kind, "process-cwd");
      const holder = probe.holders.find((item) => item.pid === child.pid);
      assert.ok(holder, JSON.stringify(probe));
      assert.equal(holder.parentPid, process.pid);
      assert.equal(holder.name.toLowerCase(), "node.exe");
      assert.equal(holder.cwd, cwd);
      assert.equal(holder.parentOfPi, false);
      assert.equal(
        child.exitCode,
        null,
        "Read-only diagnosis must not stop the directory owner",
      );
    }),
);

test(
  "Windows public cwd diagnosis preserves path boundaries and cancellation never kills the lock holder",
  {
    skip: process.platform !== "win32",
    timeout: 25000,
  },
  () =>
    withHolder(async ({ root, child }) => {
      const found = await workspaceLocks(root);
      assert.equal(found.supported, true, found.reason);
      assert.ok(found.holders.some((holder) => holder.pid === child.pid));
      const sibling = await workspaceLocks(root + "-different");
      assert.equal(sibling.supported, true, sibling.reason);
      assert.equal(
        sibling.holders.some((holder) => holder.pid === child.pid),
        false,
      );
      const controller = new AbortController();
      const pending = workspaceLocks(root, controller.signal);
      controller.abort();
      const cancelled = await pending;
      assert.equal(cancelled.supported, false);
      assert.match(cancelled.reason, /cancelled/i);
      assert.equal(
        child.exitCode,
        null,
        "Cancelling the helper must not stop the external directory owner",
      );
    }),
);

test(
  "cwd diagnosis degrades explicitly on non-Windows without invoking a native helper",
  {
    skip: process.platform === "win32",
  },
  async () => {
    const result = await workspaceLocks(os.tmpdir());
    assert.equal(result.supported, false);
    assert.equal(result.exhaustive, false);
    assert.deepEqual(result.holders, []);
    assert.match(result.reason, /Windows-only/);
  },
);
