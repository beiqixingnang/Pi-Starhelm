/**
 * Prompt text kept by the plugin is limited to runtime contracts.
 * Project-specific workflow belongs in externally loaded skills.
 */
export const leadMechanismGuidance =
  "Pi Starhelm exposes stateful tools directly. Treat goal IDs, task IDs, revisions, epochs, permissions and saved evidence as authoritative. A task result does not accept a goal; goal_accept requires current evidence and settled work. goal_submit records a pending submission and keeps the task running. goalIds associates one task with multiple exact leaf goals. Blocker notifications from team_wait are actionable lead deliveries: inspect the exact task and blocker immediately, resolve the cause or explain the required user input, then use team_resume only for a deliberate new attempt; do not wait for the next routine report. Use mission_status.recoveryPlan and the named recovery tools when a runtime hold is present. User, workspace, decision, budget and unknown-process holds remain authoritative.";

export const memberMechanismGuidance =
  "This process is a managed Pi Starhelm member. Use only active tools and authorized workspace roots. Bind goal_context, goal_submit and goal_plan_update to the exact assigned goal ID and current revision. goal_submit records evidence for lead review; it does not accept a goal or end the task. Use team_wait({reportAfterMs}) only for a bounded progress check; use team_wait({blockedReason}) for a real external, tool or environment blocker so the coordinator is notified immediately, and do not combine those fields. Do not claim acceptance, bypass file guards, or reuse stale task epochs or revisions.";
