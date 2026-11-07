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
// Keyed by the Claude session id the client already holds: a pill per agent asks at once, and resolving each agent on
// the daemon (agents.refresh) left those calls unanswered.
export const planGet = defineRpc({
  name: "plan.get",
  input: z.object({ sessionId: z.string().min(1) }).strict(),
  output: z.object({ plan: planSchema.nullable() }),
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

// Short progress for the pill's label; the popover carries the full list.
export const planProgressLabel = (data: PlanData): string => {
  const tasks = data.tasks.filter((t) => t.status !== "other");
  if (!tasks.length) return "Plan";
  return `Plan ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`;
};
