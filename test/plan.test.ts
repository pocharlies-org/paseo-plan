import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanState } from "../server/plan.ts";

const todo = (...s: string[]) => ({ type: "todo", items: s.map((status, i) => ({ id: String(i), text: `t${i}`, status })) });
const call = (callId: string, command: string, status = "running", name = "Bash") => ({ type: "tool_call", callId, name, status, detail: { type: "shell", command } });

test("commands hang on the task in progress and stay there", () => {
  const p = new PlanState();
  p.observe(todo("in_progress", "pending"));
  p.observe(call("a", "ls"));
  p.observe(call("a", "ls", "completed"));
  p.observe(todo("completed", "in_progress"));
  p.observe(call("b", "pwd"));
  const d = p.data()!;
  assert.deepEqual(d.tasks[0].commands, [{ label: "ls", status: "completed", detail: "$ ls" }]);
  assert.deepEqual(d.tasks[1].commands, [{ label: "pwd", status: "running", detail: "$ pwd" }]);
});

test("calls with no task in progress go to the other-commands entry; task tools are ignored", () => {
  const p = new PlanState();
  assert.equal(p.observe(call("x", "ls")), true);
  p.observe(todo("pending"));
  assert.equal(p.observe(call("y", "", "running", "TaskUpdate")), false);
  const d = p.data()!;
  assert.deepEqual(d.tasks.map((t) => [t.key, t.status, t.commands.length]), [["_other", "other", 1], ["0", "pending", 0]]);
});

test("a command carries its output, and the row sheds the oldest outputs past the cap", () => {
  const p = new PlanState();
  p.observe(todo("in_progress"));
  for (let i = 0; i < 60; i++) p.observe({ type: "tool_call", callId: `c${i}`, name: "Bash", status: "completed", detail: { type: "shell", command: "ls", output: "x".repeat(5000) } });
  const cmds = p.data()!.tasks[0].commands;
  assert.ok(cmds[59].detail!.startsWith("$ ls\nxxx"));
  assert.equal(cmds[0].detail, undefined);
  assert.ok(JSON.stringify(p.data()).length <= 60_000);
});
