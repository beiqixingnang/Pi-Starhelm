import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type StarhelmMode = "simple" | "complex";

export interface StarhelmModeState {
  mode: StarhelmMode;
  restoreTools?: string[];
}

interface ModeToolInfo {
  name: string;
  sourceInfo: { path: string; source: string };
}

const coreTools = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "powershell",
  "grep",
  "find",
  "ls",
]);

function stateFile(agentDir: string, sessionId: string) {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(sessionId))
    throw new Error("Invalid Pi session identity for mode state");
  return path.join(agentDir, "mission-control", "v2", sessionId, "mode.json");
}

export function readStarhelmMode(
  agentDir: string,
  sessionId: string,
): StarhelmModeState {
  try {
    const value = JSON.parse(
      fs.readFileSync(stateFile(agentDir, sessionId), "utf8"),
    );
    if (value?.mode !== "simple" && value?.mode !== "complex")
      return { mode: "complex" };
    return {
      mode: value.mode,
      ...(Array.isArray(value.restoreTools)
        ? {
            restoreTools: [...new Set(value.restoreTools)].filter(
              (name: unknown): name is string =>
                typeof name === "string" && name.length > 0,
            ),
          }
        : {}),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { mode: "complex" };
    if (error instanceof SyntaxError) return { mode: "complex" };
    throw error;
  }
}

export function writeStarhelmMode(
  agentDir: string,
  sessionId: string,
  state: StarhelmModeState,
) {
  const file = stateFile(agentDir, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    try {
      fs.renameSync(temporary, file);
    } catch (error) {
      if (
        !["EEXIST", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
      fs.rmSync(file, { force: true });
      fs.renameSync(temporary, file);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function isPiCoreTool(tool: ModeToolInfo | undefined) {
  return Boolean(
    tool &&
      coreTools.has(tool.name) &&
      tool.sourceInfo.source === "builtin" &&
      tool.sourceInfo.path === `builtin:${tool.name}`,
  );
}

export function simpleModeToolNames(
  tools: readonly ModeToolInfo[],
  activeNames: readonly string[],
) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return activeNames.filter((name) => isPiCoreTool(byName.get(name)));
}
