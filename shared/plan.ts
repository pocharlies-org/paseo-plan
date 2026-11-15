import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const KIND = "plan-progress";

// A result a task produced, never invented: the server attaches only links that come from explicit data — a PR/issue
// URL a shell command printed in its own output, a Jira browse URL of the ticket, a file path a completed Write/Edit
// named and that still exists on disk. Safe by construction: https, no credentials, no query (SC-5089).
export const linkSchema = z.object({
  kind: z.enum(["pr", "ticket", "file"]),
  href: z.string(),
  label: z.string(),
});

export type PlanLink = z.output<typeof linkSchema>;

export const planSchema = z.object({
  tasks: z.array(
    z.object({
      key: z.string(),
      text: z.string(),
      activeForm: z.string().optional(),
      status: z.enum(["pending", "in_progress", "completed", "other"]),
      // Which of the session's plans the task belongs to, 0 first (from the task files, see server/tasks.ts).
      plan: z.number().int().nonnegative().optional(),
      // Task ids this one waits on, only when the task file says so (Claude Code's `blockedBy`). Absent means no
      // information, never "not blocked": blocked state is never inferred from the task's text (SC-5089).
      blockedBy: z.array(z.string()).optional(),
      // Results of the task, extracted by the server from its commands (see linkSchema).
      links: z.array(linkSchema).optional(),
      commands: z.array(
        z.object({
          label: z.string(),
          status: z.enum(["running", "completed", "failed", "canceled"]),
          detail: z.string().optional(),
        }),
      ),
    }),
  ),
  // The session's ticket, when the anchor found one: key plus its browse URL, so the UI can link it (SC-5089).
  ticket: z.object({ key: z.string(), url: z.string() }).optional(),
});

export type PlanData = z.output<typeof planSchema>;
export type PlanTask = PlanData["tasks"][number];

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

// The task files carry no commands, no links and no ticket: a reread (e.g. after a reconnect) keeps the ones the live
// rows already showed, matched by task text, and their "other commands" entry.
export const keepCommands = (files: PlanData, live: PlanData | null): PlanData => {
  if (!live) return files;
  const byText = new Map(live.tasks.filter((t) => t.status !== "other").map((t) => [t.text, t]));
  const other = live.tasks.filter((t) => t.status === "other");
  return {
    tasks: [
      ...other,
      ...files.tasks.map((t) => {
        const l = byText.get(t.text);
        return { ...t, commands: l?.commands ?? t.commands, ...(l?.links?.length ? { links: l.links } : {}) };
      }),
    ],
    ...(live.ticket ? { ticket: live.ticket } : {}),
  };
};

// The state a task is in, from explicit data only — never from words in its text (SC-5089): completed and in progress
// from the status; blocked only when the task file lists blockedBy ids not all completed; waiting otherwise. A session
// whose task files carry no blockedBy never shows "bloqueado": the absence is no information, not a state.
export type TaskState = "completed" | "running" | "blocked" | "waiting" | "other";
export const taskState = (task: PlanTask, tasks: readonly PlanTask[]): TaskState => {
  if (task.status === "other") return "other";
  if (task.status === "completed") return "completed";
  if (task.status === "in_progress") return "running";
  if (task.blockedBy?.length) {
    const done = new Set(tasks.filter((t) => t.status === "completed").map((t) => t.key));
    return task.blockedBy.some((id) => !done.has(id)) ? "blocked" : "waiting";
  }
  return "waiting";
};

// The error that matters for a task: its last failed command, the one the UI keeps visible (SC-5089).
export const lastFailedCommand = (commands: readonly PlanTask["commands"][number][]) =>
  commands.toReversed().find((c) => c.status === "failed");

// The pill's text: progress of the latest plan plus the task in progress, the task cut to keep the composer row short;
// title carries the same sentence in full for the accessible read (SC-5089).
const PILL_TASK_MAX = 40;
export const planPillLabel = (data: PlanData): { label: string; title: string } => {
  const progress = planProgressLabel(data);
  const active = splitPlans(data).current.tasks.find((t) => t.status === "in_progress");
  if (!active) return { label: progress, title: progress };
  const text = active.activeForm ?? active.text;
  const short = text.length > PILL_TASK_MAX ? `${text.slice(0, PILL_TASK_MAX - 1)}…` : text;
  return { label: `${progress} · ${short}`, title: `${progress} · ${text}` };
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
