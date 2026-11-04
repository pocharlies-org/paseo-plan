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

// Short progress for the pill's label; the popover carries the full list.
export const planProgressLabel = (data: PlanData): string => {
  const tasks = data.tasks.filter((t) => t.status !== "other");
  if (!tasks.length) return "Plan";
  return `Plan ${tasks.filter((t) => t.status === "completed").length}/${tasks.length}`;
};
