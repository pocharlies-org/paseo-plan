import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planFromTasks } from "../server/tasks.ts";

const SID = "6a7c0e2f-1460-4f8c-b902-027554ee8767";

test("reads a session's task files in task order, skipping broken and foreign files", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-tasks-"));
  await mkdir(join(root, SID));
  const task = (id: string, status: string, extra = {}) =>
    writeFile(join(root, SID, `${id}.json`), JSON.stringify({ id, subject: `t${id}`, status, blocks: [], ...extra }));
  await task("10", "pending");
  await task("2", "in_progress", { activeForm: "Haciendo t2" });
  await task("1", "completed");
  await writeFile(join(root, SID, "3.json"), "{ half-writ");
  await writeFile(join(root, SID, ".lock"), "");
  const plan = await planFromTasks(SID, root);
  assert.deepEqual(plan, {
    tasks: [
      { key: "1", text: "t1", status: "completed", commands: [], plan: 0 },
      { key: "2", text: "t2", activeForm: "Haciendo t2", status: "in_progress", commands: [], plan: 0 },
      { key: "10", text: "t10", status: "pending", commands: [], plan: 0 },
    ],
  });
});

test("no directory, no tasks, or anything but a session id: no plan and no filesystem access outside the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-tasks-"));
  assert.equal(await planFromTasks(SID, root), null);
  await mkdir(join(root, SID));
  assert.equal(await planFromTasks(SID, root), null);
  await writeFile(join(root, "x.json"), JSON.stringify({ id: "1", subject: "escaped", status: "pending" }));
  assert.equal(await planFromTasks("..", root), null);
  assert.equal(await planFromTasks(`../${SID}`, root), null);
});

test("a task made after every earlier one was completed starts a new plan; one made with work still open does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-tasks-"));
  await mkdir(join(root, SID));
  const task = (id: string, status: string) =>
    writeFile(join(root, SID, `${id}.json`), JSON.stringify({ id, subject: `t${id}`, status }));
  const tick = () => new Promise((r) => setTimeout(r, 20));
  await task("1", "pending");
  await task("2", "pending");
  await tick();
  await task("3", "pending"); // 1 and 2 were still open: same plan
  for (const id of ["1", "2", "3"]) await task(id, "completed");
  await tick();
  await task("4", "in_progress"); // everything before was done: the approved plan
  await task("5", "pending");
  const plan = await planFromTasks(SID, root);
  assert.deepEqual(plan!.tasks.map((t) => [t.key, t.plan]), [["1", 0], ["2", 0], ["3", 0], ["4", 1], ["5", 1]]);
  // a copied file keeps its old change time but is born at the copy: no cut on its account
  await utimes(join(root, SID, "4.json"), new Date(0), new Date(0));
  assert.deepEqual((await planFromTasks(SID, root))!.tasks.map((t) => t.plan), [0, 0, 0, 0, 0]);
});
