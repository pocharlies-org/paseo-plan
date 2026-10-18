import { TASK_TOOLS, type PlanData } from "../shared/plan.ts";

interface Item {
  type: string;
  [key: string]: unknown;
}
interface Call {
  label: string;
  detail?: string;
  status: PlanData["tasks"][number]["commands"][number]["status"];
}
interface Task {
  key: string;
  text: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
}

const OTHER = "_other";
const MAX_CALLS = 200; // the row is capped at 64 KiB
const MAX_LABEL = 160;
const MAX_DETAIL = 2000;
const MAX_ROW = 60_000;

const base = (path: unknown) => String(path).split("/").slice(-2).join("/");

export function label(item: Item): string {
  const d = (item.detail ?? {}) as Record<string, unknown>;
  switch (d.type) {
    case "shell": return String(d.command).split("\n")[0].slice(0, MAX_LABEL);
    case "read": return `Read ${base(d.filePath)}`;
    case "edit": return `Edit ${base(d.filePath)}`;
    case "write": return `Write ${base(d.filePath)}`;
    case "search": return `${d.toolName ?? "Search"} ${d.query}`;
    case "fetch": return `Fetch ${d.url}`;
    case "sub_agent": return `Agent ${d.description ?? ""}`.trim();
    default: return String(item.name);
  }
}

const clip = (text: unknown) => {
  const t = typeof text === "string" ? text : "";
  return t.length > MAX_DETAIL ? `${t.slice(0, MAX_DETAIL)}\n… (${t.length - MAX_DETAIL} más)` : t;
};

/** What the command did, for the expanded line: the shell command and its output, the diff, the search hits. */
export function detail(item: Item): string | undefined {
  const d = (item.detail ?? {}) as Record<string, unknown>;
  let text: unknown;
  switch (d.type) {
    case "shell": text = `$ ${d.command}${d.output ? `\n${d.output}` : ""}`; break;
    case "read": case "write": case "search": text = d.content; break;
    case "edit": text = d.unifiedDiff; break;
    case "fetch": text = d.result; break;
    case "sub_agent": text = d.log; break;
    case "plain_text": text = d.text; break;
    case "unknown": text = d.output == null ? undefined : typeof d.output === "string" ? d.output : JSON.stringify(d.output); break;
  }
  return clip(text) || undefined;
}

/** Folds the live timeline into Claude's latest task list, hanging each tool call on the task in progress when it started. */
export class PlanState {
  private tasks: Task[] = [];
  private calls = new Map<string, Map<string, Call>>();
  private owner = new Map<string, string>();

  observe(item: Item): boolean {
    if (item.type === "todo") {
      const items = item.items as Array<{ id?: string; text: string; status?: Task["status"]; completed?: boolean; activeForm?: string }>;
      this.tasks = items.map((t) => ({
        key: t.id ?? t.text,
        text: t.text,
        activeForm: t.activeForm,
        status: t.status ?? (t.completed ? "completed" : "pending"),
      }));
      return true;
    }
    if (item.type !== "tool_call" || TASK_TOOLS.has(String(item.name))) return false;
    const callId = String(item.callId);
    const key = this.owner.get(callId) ?? this.tasks.find((t) => t.status === "in_progress")?.key ?? OTHER;
    this.owner.set(callId, key);
    const bucket = this.calls.get(key) ?? new Map<string, Call>();
    bucket.set(callId, { label: label(item), detail: detail(item), status: item.status as Call["status"] });
    this.calls.set(key, bucket);
    return true;
  }

  data(): PlanData | null {
    const commands = (key: string) => [...(this.calls.get(key)?.values() ?? [])].slice(-MAX_CALLS);
    const other = commands(OTHER);
    const tasks: PlanData["tasks"] = this.tasks.map((t) => ({ ...t, commands: commands(t.key) }));
    if (other.length) tasks.unshift({ key: OTHER, text: "", status: "other", commands: other }); // the client words it
    if (!tasks.length) return null;
    // The row is capped at 64 KiB: shed the oldest outputs first.
    const withDetail = tasks.flatMap((t) => t.commands).filter((c) => c.detail);
    let size = JSON.stringify(tasks).length;
    for (const c of withDetail) {
      if (size <= MAX_ROW) break;
      size -= c.detail!.length;
      delete c.detail;
    }
    return { tasks };
  }
}
