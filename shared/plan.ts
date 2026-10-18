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
