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

test("a call another plugin draws as its own card stays out of the plan", () => {
  const p = new PlanState();
  p.observe(todo("in_progress"));
  assert.equal(p.observe(call("s", "", "running", "mcp__rutador__start_session")), false);
  assert.deepEqual(p.data()!.tasks[0].commands, []);
});

test("a reread from the task files keeps the commands the live rows showed", async () => {
  const { keepCommands } = await import("../shared/plan.ts");
  const cmd = { label: "ls", status: "completed" as const };
  const live = {
    tasks: [
      { key: "_other", text: "", status: "other" as const, commands: [cmd] },
      { key: "a", text: "t1", status: "in_progress" as const, commands: [cmd] },
    ],
  };
  const files = {
    tasks: [
      { key: "1", text: "t1", status: "completed" as const, commands: [] },
      { key: "2", text: "t2", status: "pending" as const, commands: [] },
    ],
  };
  assert.deepEqual(keepCommands(files, live).tasks.map((t) => [t.text, t.status, t.commands.length]), [["", "other", 1], ["t1", "completed", 1], ["t2", "pending", 0]]);
  assert.equal(keepCommands(files, null), files);
});
