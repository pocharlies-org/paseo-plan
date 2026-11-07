import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
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
      { key: "1", text: "t1", status: "completed", commands: [] },
      { key: "2", text: "t2", activeForm: "Haciendo t2", status: "in_progress", commands: [] },
      { key: "10", text: "t10", status: "pending", commands: [] },
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
