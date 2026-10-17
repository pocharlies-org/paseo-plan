// The plan of one agent, folded from its timeline rows in order. A `todo` row is a full snapshot of the task list (Paseo
// builds it from TodoWrite/TaskCreate/TaskUpdate and the other providers' equivalents); a user message after it makes the
// plan one the agent has not revisited since — what Claude Desktop labels «Plan anterior a tu último mensaje».
export type Task = {
  text: string;
  completed: boolean;
  id?: string;
  status?: "pending" | "in_progress" | "completed";
  activeForm?: string;
};
export type Plan = { tasks: readonly Task[]; stale: boolean };

export function fold(plan: Plan | null, item: { type: string }): Plan | null {
  if (item.type === "todo") {
    const tasks = (item as { items?: readonly Task[] }).items ?? [];
    return tasks.length ? { tasks, stale: false } : null;
  }
  if (item.type === "user_message" && plan) return { ...plan, stale: true };
  return plan;
}

export function taskStatus(task: Task): NonNullable<Task["status"]> {
  return task.status ?? (task.completed ? "completed" : "pending");
}

export function planLabel(plan: Plan): string {
  const done = plan.tasks.filter((task) => taskStatus(task) === "completed").length;
  const current = plan.tasks.find((task) => taskStatus(task) === "in_progress");
  const head = `Plan ${done}/${plan.tasks.length}`;
  return current ? `${head} · ${current.activeForm ?? current.text}` : head;
}
