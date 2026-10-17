import assert from "node:assert/strict";
import { test } from "node:test";
import { fold, planLabel, type Plan } from "../shared/plan.ts";

const todo = (...items: Array<[string, "pending" | "in_progress" | "completed"]>) => ({
  type: "todo",
  items: items.map(([text, status]) => ({ text, status, completed: status === "completed" })),
});
const run = (...rows: Array<{ type: string }>) => rows.reduce<Plan | null>(fold, null);

test("no todo row, no plan", () => {
  assert.equal(run({ type: "user_message" }, { type: "assistant_message" }), null);
});

test("the last todo snapshot wins and the label names the step in progress", () => {
  const plan = run(
    { type: "user_message" },
    todo(["Leer", "in_progress"], ["Arreglar", "pending"]),
    todo(["Leer", "completed"], ["Arreglar", "in_progress"], ["Probar", "pending"]),
  );
  assert.equal(plan?.stale, false);
  assert.equal(planLabel(plan!), "Plan 1/3 · Arreglar");
});

test("a user message after the plan marks it as previous", () => {
  const plan = run(todo(["Leer", "in_progress"]), { type: "assistant_message" }, { type: "user_message" });
  assert.equal(plan?.stale, true);
});

test("a new snapshot after the user message is current again", () => {
  const plan = run(todo(["Leer", "in_progress"]), { type: "user_message" }, todo(["Leer", "completed"]));
  assert.deepEqual([plan?.stale, planLabel(plan!)], [false, "Plan 1/1"]);
});

test("an emptied list removes the plan", () => {
  assert.equal(run(todo(["Leer", "pending"]), todo()), null);
});

test("legacy rows without status read from completed", () => {
  const plan = run({ type: "todo", items: [{ text: "A", completed: true }, { text: "B", completed: false }] } as { type: string });
  assert.equal(planLabel(plan!), "Plan 1/2");
});
