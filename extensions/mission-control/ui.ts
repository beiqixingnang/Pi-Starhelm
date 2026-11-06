import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { cleanText } from "../../runtime/public.ts";
import type { Mission, Recovery } from "../../runtime/types.ts";
import type { MissionKernel } from "../../runtime/kernel.ts";
import { panelLine, type UiTheme } from "./presentation.ts";

export const stateNames: Record<string, string> = {
  active: "推进中",
  paused: "暂停中",
  waiting_user: "等待用户",
  complete: "已验收",
  stopped: "已停止",
  attention: "需要处理",
  queued: "排队",
  running: "执行中",
  waiting: "等待下游",
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  interrupted: "中断待核对",
};
export function missionState(
  m?: Mission,
  recovery?: Recovery,
  workspaceHeld = false,
) {
  if (workspaceHeld) return "迁移后待恢复";
  if (!m && !recovery) return "就绪";
  if (m?.status === "paused") return stateNames.paused;
  if (m && m.status !== "active")
    return m.blocker?.kind === "budget"
      ? "预算耗尽"
      : m.blocker?.kind === "no_progress"
        ? "进展待核对"
        : stateNames[m.status];
  if (recovery)
    return {
      waiting_compaction: "等待压缩恢复",
      compacting: "正在压缩",
      compaction_failed: "压缩失败待重试",
      cooldown: "恢复等待",
      ready: "等待恢复验证",
      probing: "恢复验证中",
      exhausted: "恢复冷却",
      blocked: "等待外部修复",
    }[recovery.phase];
  return m?.externalWait ? "等待外部事件" : m ? stateNames[m.status] : "就绪";
}
function cell(text: string, width: number) {
  const value = truncateToWidth(
    cleanText(text.replace(/\s+/g, " "), 400),
    Math.max(1, width),
  );
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
function duration(ms: number) {
  if (ms >= 3600000)
    return `${Math.floor(ms / 3600000)}小时${Math.floor(ms / 60000) % 60}分`;
  if (ms >= 60000) return `${Math.floor(ms / 60000)}分`;
  return `${Math.floor(ms / 1000)}秒`;
}
export function board(
  kernel: MissionKernel,
  width: number,
  expanded = false,
  theme?: UiTheme,
  terminalRows = 30,
): string[] {
  const s = kernel.dashboardSnapshot(12, true),
    m = s.mission;
  const limit = expanded
    ? 100
    : Math.max(4, Math.min(10, Math.floor(terminalRows / 3)));
  const held = s.held || m?.humanPaused || s.workspaceHeld;
  const due = (time: number) =>
    time <= Date.now()
      ? "已到期"
      : `${Math.max(1, Math.ceil((time - Date.now()) / 60000))}分后`;
  const schedules = s.schedules
    .filter((x) => x.state === "active")
    .sort((a, b) => a.nextAt - b.nextAt || a.id.localeCompare(b.id));
  const memberRows = s.members
    .map((member) => {
      const task = s.memberTasks[member.id];
      const activity = kernel.store.get<{ tool?: string }>(
        `activity:${member.id}`,
      );
      const needsAttention = Boolean(
        task &&
          (task.blockedReason ||
            task.state === "failed" ||
            task.state === "interrupted" ||
            task.processState === "unknown"),
      );
      const status =
        task?.processState === "unknown"
          ? "进程待核对"
          : task?.blockedReason
            ? "阻塞"
            : task
              ? (stateNames[task.state] ?? task.state)
              : "待命";
      const priority =
        task?.state === "running" && !needsAttention
          ? 0
          : needsAttention
            ? 1
            : task?.state === "queued"
              ? 2
              : task?.state === "waiting"
                ? 3
                : 4;
      return {
        category: "子智能体",
        id: member.id,
        name: member.name,
        status,
        priority,
        hiddenStatus: needsAttention
          ? "需处理"
          : task?.state === "waiting"
            ? "等待"
            : status,
        detail: task?.blockedReason
          ? cleanText(task.blockedReason, 160)
          : task?.state === "running"
            ? (activity?.tool ?? "工作中")
            : task?.phase === "review"
              ? "复核"
              : "",
      };
    })
    .sort(
      (a, b) =>
        a.priority - b.priority ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  const goals = s.goalRoots
    .map((goal) => (goal.id === m?.id ? m : kernel.store.savedMission(goal.id)))
    .filter((goal): goal is Mission =>
      Boolean(
        goal &&
          !goal.archivedAt &&
          !["complete", "stopped"].includes(goal.status),
      ),
    )
    .sort((a, b) => Number(b.id === m?.id) - Number(a.id === m?.id));
  const goalRows = goals.slice(0, Math.max(1, limit - 3)).map((goal) => {
    const selected = goal.id === m?.id;
    const progress =
      (selected ? s.goals : s.goalSummaries[goal.id]) ??
      kernel.goals.summary(goal.id);
    return {
      category: "目标",
      name: goal.objective,
      status:
        !selected && goal.status === "active"
          ? "待推进"
          : missionState(
              goal,
              selected ? s.recovery : undefined,
              selected && s.workspaceHeld,
            ),
      detail:
        selected && s.workspaceHeld
          ? "/mission resume 手动恢复"
          : `二级${progress.level2.completed}/${progress.level2.total} 三级${progress.level3.completed}/${progress.level3.total}`,
    };
  });
  if (s.workspaceHeld && !goals.some((goal) => goal.id === m?.id))
    goalRows.unshift({
      category: "工作区",
      name: "工作区已迁移",
      status: "迁移后待恢复",
      detail: "手动执行 /mission resume",
    });
  if (!goalRows.length)
    goalRows.push({
      category: "目标",
      name: "无活跃或暂停目标",
      status: "就绪",
      detail: "",
    });
  const reminderRows = schedules.map((r) => ({
    category: "定时任务",
    name: r.title,
    status: held ? "暂停投递" : r.intervalMs ? "周期提醒" : "一次提醒",
    detail: due(r.nextAt),
  }));
  if (m && !["complete", "stopped"].includes(m.status)) {
    const ready =
      m.status === "active" && !held && !s.recovery && !m.externalWait;
    reminderRows.push({
      category: "定时任务",
      name: "进度汇报",
      status: ready
        ? "每" + duration(kernel.settings.progressIntervalMs)
        : "等待恢复",
      detail: ready && s.nextReportAt ? due(s.nextReportAt) : "等待期间停发",
    });
  }
  const reminderCount = reminderRows.length;
  if (!reminderCount)
    reminderRows.push({
      category: "定时任务",
      name: "无",
      status: "—",
      detail: "",
    });
  const table = width >= 76 && limit >= 7;
  const remindersShown = Math.min(
    reminderRows.length,
    table && limit >= 10 ? 2 : 1,
  );
  const goalsShown = goalRows.slice(
    0,
    Math.max(
      1,
      limit - 3 - (table ? remindersShown : 0) - Number(memberRows.length > 0),
    ),
  );
  const hiddenGoals = Math.max(
    0,
    s.goalRootCount -
      goalsShown.filter(
        (row) => row.category === "目标" && row.status !== "就绪",
      ).length,
  );
  const availableMembers = Math.max(
    0,
    limit - 3 - remindersShown - goalsShown.length,
  );
  const shown = memberRows.slice(0, availableMembers);
  const hiddenReminders = reminderRows.length - remindersShown;
  const footer = (visibleMembers: number, remindersHidden: number) => {
    const counts = new Map<string, number>();
    for (const member of memberRows.slice(visibleMembers))
      counts.set(
        member.hiddenStatus,
        (counts.get(member.hiddenStatus) ?? 0) + 1,
      );
    const hidden = [...counts]
      .map(([state, count]) => `${count}${state}`)
      .join("、");
    return [
      hidden ? `另有 ${hidden}` : "",
      hiddenGoals ? `另有 ${hiddenGoals}个目标` : "",
      remindersHidden ? `另有 ${remindersHidden}项提醒` : "",
      "/mission goals 目标详情 · /agents 成员对话",
    ]
      .filter(Boolean)
      .join(" · ");
  };
  let lines: string[];
  if (table) {
    const widths = [8, width - 57, 14, 26];
    const row = (r: {
      category: string;
      name: string;
      status: string;
      detail: string;
    }) =>
      [r.category, r.name, r.status, r.detail]
        .map((t, i) => cell(t, widths[i]))
        .join(" │ ");
    const header = row({
      category: "类别",
      name: "名称 / 内容",
      status: "状态",
      detail: "时间 / 进展",
    });
    lines = [
      theme?.fg?.("accent", theme?.bold?.(header) ?? header) ?? header,
      "─".repeat(width),
      ...goalsShown.map(row),
      ...reminderRows.slice(0, remindersShown).map(row),
      ...shown.map(row),
      footer(shown.length, hiddenReminders),
    ];
  } else {
    const running = memberRows.filter((r) => r.status === "执行中").length,
      waiting = memberRows.filter((r) => r.status === "等待下游").length;
    const memberLine = (r: (typeof goalRows)[number]) =>
      `${cell(r.name, Math.max(1, width - 13))} ${r.status}`;
    const showProgress =
      goalsShown.length === 1 &&
      Boolean(goalsShown[0].detail) &&
      limit > goalsShown.length + 3 + Number(memberRows.length > 0);
    const showMemberSummary =
      !memberRows.length ||
      limit - goalsShown.length - 3 - Number(showProgress) >= 1;
    const compactShown = memberRows.slice(
      0,
      Math.max(
        0,
        limit -
          goalsShown.length -
          2 -
          Number(showProgress) -
          Number(showMemberSummary),
      ),
    );
    lines = [
      ...goalsShown.map(
        (goal) =>
          `${goal.category} · ${goal.status} · ${goal.name}${goal.category === "工作区" ? " · " + goal.detail : ""}`,
      ),
      ...(showProgress
        ? [
            s.workspaceHeld
              ? "请手动执行 /mission resume"
              : `${goalsShown[0].detail} 已验收`,
          ]
        : []),
      `定时 · ${reminderCount}项${reminderCount ? " · " + reminderRows[0].detail + " " + reminderRows[0].name : " · 无"}`,
      ...(showMemberSummary
        ? [`成员 · ${memberRows.length}名 · 执行 ${running} · 等待 ${waiting}`]
        : []),
      ...compactShown.map(memberLine),
      footer(compactShown.length, Math.max(0, reminderCount - 1)),
    ];
  }
  if (expanded) {
    if (m?.reason && goals.some((goal) => goal.id === m.id))
      lines.push(`需处理：${cleanText(m.reason, 240)}`);
    if (s.recovery)
      lines.push(
        `恢复原因 ${cleanText(s.recovery.reason, 240)} · 本轮失败 ${s.recovery.burstFailures ?? s.recovery.requests}/${kernel.settings.recoveryMaxRequests} · 累计请求 ${s.recovery.requests}${s.recovery.nextAt ? " · 下次检查 " + new Date(s.recovery.nextAt).toISOString() : ""}`,
      );
    if (m && goals.some((goal) => goal.id === m.id))
      lines.push(
        `活动耗时 ${duration(s.activity?.activeMs ?? 0)} · 时间预算 ${kernel.settings.maxMissionMs ? duration(kernel.settings.maxMissionMs) : "无时间上限"}`,
        `自动接续 ${m.turns}/${kernel.settings.maxAutonomousTurns || "不限"} · 主输出 ${m.outputTokens}/${kernel.settings.maxOutputTokens || "不限"}`,
      );
    lines.push("Esc 返回 · /mission pause|resume|stop 控制任务");
  }
  return lines
    .slice(0, expanded ? 100 : limit)
    .map((line) =>
      panelLine(
        truncateToWidth(line, Math.max(1, width)),
        width,
        "customMessageBg",
        theme,
      ),
    );
}

export function createBoardRenderer(kernel: MissionKernel) {
  let cachedLines: string[] | undefined;
  let cachedVersion = -1;
  let cachedWidth = -1;
  let cachedRows = -1;
  let cachedMinute = -1;
  let cachedTheme: UiTheme | undefined;
  let invalidated = true;

  return {
    invalidate() {
      invalidated = true;
    },
    render(width: number, theme?: UiTheme, terminalRows = 30) {
      const version = kernel.store.changeCount();
      const minute = Math.floor(Date.now() / 60000);
      if (
        invalidated ||
        !cachedLines ||
        version !== cachedVersion ||
        width !== cachedWidth ||
        terminalRows !== cachedRows ||
        minute !== cachedMinute ||
        theme !== cachedTheme
      ) {
        cachedLines = board(kernel, width, false, theme, terminalRows);
        cachedVersion = version;
        cachedWidth = width;
        cachedRows = terminalRows;
        cachedMinute = minute;
        cachedTheme = theme;
        invalidated = false;
      }
      return cachedLines;
    },
  };
}
