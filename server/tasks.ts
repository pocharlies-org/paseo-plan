import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlanData } from "../shared/plan.ts";

// A Claude Code session id; anything else never reaches the filesystem.
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Set(["pending", "in_progress", "completed"]);

/** Claude Code's task list of one session (~/.claude/tasks/<session id>/<n>.json) in task order; null with no tasks. */
export async function planFromTasks(sessionId: string, root = join(homedir(), ".claude", "tasks")): Promise<PlanData | null> {
  if (!SESSION.test(sessionId)) return null;
  const dir = join(root, sessionId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return null; // a session that never made a task has no directory
  }
  const tasks: PlanData["tasks"] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const t = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (typeof t?.subject !== "string" || !STATUS.has(t.status)) continue;
      tasks.push({
        key: String(t.id ?? name),
        text: t.subject,
        ...(typeof t.activeForm === "string" ? { activeForm: t.activeForm } : {}),
        status: t.status,
        commands: [],
      });
    } catch {
      // a half-written file is skipped; the next read sees it whole
    }
  }
  tasks.sort((a, b) => Number(a.key) - Number(b.key) || a.key.localeCompare(b.key));
  return tasks.length ? { tasks } : null;
}
