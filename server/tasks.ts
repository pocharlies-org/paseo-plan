import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanData } from "../shared/plan.ts";

// A Claude Code session id; anything else never reaches the filesystem.
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(["pending", "in_progress", "completed"]);
const BURST_MS = 60_000;

/**
 * Claude Code's task list of one session (~/.claude/tasks/<session id>/<n>.json) in task order, each task with its plan;
 * null with no tasks. A new plan starts where at least two tasks are written at once after every earlier task was
 * completed: the list of a plan Dani just approved (SC-5050). Claude Code rewrites a task file in place, so its birth time is when the task was made.
 */
export async function planFromTasks(sessionId: string, root = join(homedir(), ".claude", "tasks")): Promise<PlanData | null> {
  if (!SESSION.test(sessionId)) return null;
  const dir = join(root, sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // a session that never made a task has no directory
  }
  const read: Array<{ task: PlanData["tasks"][number]; born: number; changed: number }> = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const file = join(dir, name);
      const [t, s] = [JSON.parse(await readFile(file, "utf8")), await stat(file)];
      if (typeof t?.subject !== "string" || !STATUS.has(t.status)) continue;
      const task = {
        key: String(t.id ?? name),
        text: t.subject,
        ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
        status: t.status,
        // Claude Code's explicit wait list (SC-5089): only when the file carries it non-empty — its absence is no
        // information, and a task is never shown as blocked because of what its text says.
        ...(Array.isArray(t.blockedBy) && t.blockedBy.length ? { blockedBy: t.blockedBy.map(String) } : {}),
        commands: [],
      };
      // A copied file (the home moved to a volume) was born after its last change: its birth says nothing.
      read.push({ task, born: s.birthtimeMs <= s.mtimeMs ? s.birthtimeMs : 0, changed: s.mtimeMs });
    } catch {
      // a half-written file is skipped; the next read sees it whole
    }
  }
  read.sort((a, b) => Number(a.task.key) - Number(b.task.key) || a.task.key.localeCompare(b.task.key));
  // A filesystem without birth times reports 0: never a cut, one plan as before.
  let plan = 0;
  let allDone = true;
  let lastChange = 0;
  for (const [i, { task, born, changed }] of read.entries()) {
    // A plan is a list written at once: one task added alone after the rest is extra work of the plan it follows.
    const listed = (read[i + 1]?.born ?? Infinity) - born < BURST_MS;
    if (lastChange && allDone && born > lastChange && listed) plan++;
    task.plan = plan;
    allDone &&= task.status === "completed";
    lastChange = Math.max(lastChange, changed);
  }
  return read.length ? { tasks: read.map((r) => r.task) } : null;
}
