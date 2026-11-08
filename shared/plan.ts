import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const KIND = "plan-progress";

export const planSchema = z.object({
  tasks: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
      activeForm: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed", "other"]),
      // Which of the session's plans the task belongs to, 0 first (from the task files, see server/tasks.ts).
      plan: z.number().int().nonnegative().optional(),
      commands: z.array(
        z.object({
          label: z.string(),
          status: z.enum(["running", "completed", "failed", "canceled"]),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
});

export type PlanData = z.output<typeof planSchema>;

// The plan as Claude Code keeps it on the daemon host (~/.claude/tasks/<session id>), for whatever opens without the
// live rows: the pill after a reload, the popover, the side panel. The live plan-progress rows then add the commands.
// Keyed by the Claude session ids the client already holds, many per call: the pills of every agent ask together, since
// one call per pill (~140) queued the side panel's own read behind them for most of a minute.
export const planGet = defineRpc({
  name: "plan.get",
  input: z.object({ sessionIds: z.array(z.string().min(1)).min(1).max(1000) }).strict(),
  output: z.object({ plans: z.record(z.string(), planSchema.nullable()) }),
});

// The task tools themselves are the plan, not work done for it.
export const TASK_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop"]);

// Tool calls another plugin draws as a card of its own (paseo-rutador's session cards): the plan neither folds them in
// nor hides their rows, or that card would never reach the timeline (the first transformer to answer wins).
export const ownCardElsewhere = (name: unknown) => String(name).startsWith("mcp__rutador__");

// The plugin row the server appends is the plan's data channel for the composer pill: the pill reads the same folded
// state instead of re-folding the timeline on the client. Null for any other row.
export const planFromTimelineItem = (item: unknown): PlanData | null => {
  const i = item as { type?: unknown; kind?: unknown; data?: unknown } | null;
  if (!i || i.type !== "plugin" || i.kind !== KIND) return null;
  const parsed = planSchema.safeParse(i.data);
  return parsed.success ? parsed.data : null;
};

// The task files carry no commands: a reread (e.g. after a reconnect) keeps the ones the live rows already showed,
// matched by task text, and their "other commands" entry.
export const keepCommands = (files: PlanData, live: PlanData | null): PlanData => {
  if (!live) return files;
  const byText = new Map(live.tasks.filter((t) => t.status !== "other").map((t) => [t.text, t.commands]));
  const other = live.tasks.filter((t) => t.status === "other");
  return { tasks: [...other, ...files.tasks.map((t) => ({ ...t, commands: byText.get(t.text) ?? t.commands }))] };
};

// The latest plan (with the other-commands entry and any task not placed yet) and the earlier ones, oldest first: the
// pill and the conversation card show the latest, the popover and the panel also list the earlier ones folded (SC-5050).
export const splitPlans = (data: PlanData) => {
  const last = Math.max(0, ...data.tasks.map((t) => t.plan ?? 0));
  const earlier = Array.from({ length: last }, (_, i) => data.tasks.filter((t) => t.plan === i)).filter((g) => g.length);
  return { current: { tasks: data.tasks.filter((t) => (t.plan ?? last) === last) }, earlier };
};

// Short progress of the latest plan for the pill's label; the popover carries the full list.
export const planProgressLabel = (data: PlanData): string => {
  const tasks = splitPlans(data).current.tasks.filter((t) => t.status !== "other");
  if (!tasks.length) return "Plan";
  return `Plan ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`;
};
