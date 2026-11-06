import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  isPiCoreTool,
  readStarhelmMode,
  simpleModeToolNames,
  writeStarhelmMode,
} from "../../runtime/mode.ts";

test("Starhelm mode defaults to complex and persists per conversation", () => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "starhelm-mode-"));
  try {
    assert.deepEqual(readStarhelmMode(agentDir, "session-1"), {
      mode: "complex",
    });
    writeStarhelmMode(agentDir, "session-1", {
      mode: "simple",
      restoreTools: ["read", "mission_status", "read"],
    });
    assert.deepEqual(readStarhelmMode(agentDir, "session-1"), {
      mode: "simple",
      restoreTools: ["read", "mission_status"],
    });
    assert.deepEqual(readStarhelmMode(agentDir, "session-2"), {
      mode: "complex",
    });
    writeStarhelmMode(agentDir, "session-1", {
      mode: "complex",
      restoreTools: ["read", "mission_status"],
    });
    assert.equal(readStarhelmMode(agentDir, "session-1").mode, "complex");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("simple mode preserves only active native Pi tools", () => {
  const tools = [
    {
      name: "read",
      sourceInfo: { path: "builtin:read", source: "builtin" },
    },
    {
      name: "bash",
      sourceInfo: { path: "builtin:bash", source: "builtin" },
    },
    {
      name: "codemode",
      sourceInfo: { path: "builtin:codemode", source: "builtin" },
    },
    {
      name: "mission_status",
      sourceInfo: {
        path: "/plugin/mission-control/index.ts",
        source: "package",
      },
    },
  ];
  assert.deepEqual(simpleModeToolNames(tools, ["read", "codemode", "bash"]), [
    "read",
    "bash",
  ]);
  assert.equal(isPiCoreTool(tools[0]), true);
  assert.equal(isPiCoreTool(tools[2]), false);
  assert.equal(isPiCoreTool(tools[3]), false);
});

test("invalid session identities cannot escape the per-session state directory", () => {
  const agentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "starhelm-mode-path-"),
  );
  try {
    assert.throws(
      () => writeStarhelmMode(agentDir, "../other", { mode: "simple" }),
      /Invalid Pi session identity/,
    );
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});
