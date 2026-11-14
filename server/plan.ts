import { stat } from "node:fs/promises";
import { TASK_TOOLS, ownCardElsewhere, type PlanData, type PlanLink } from "../shared/plan.ts";

interface Item {
  type: string;
  [key: string]: unknown;
}
interface Call {
  label: string;
  detail?: string;
  status: PlanData["tasks"][number]["commands"][number]["status"];
  links?: PlanLink[];
}
interface Task {
  key: string;
  text: string;
  activeForm?: string;
  status: "pending" | "in_progress" | "completed";
  blockedBy?: string[];
}

const OTHER = "_other";
const MAX_CALLS = 200; // the row is capped at 64 KiB
const MAX_LABEL = 160;
const MAX_DETAIL = 2000;
const MAX_ROW = 60_000;
const MAX_LINKS = 8; // per task, keeps the row bounded even with chatty commands

// The Jira site for constructed links only from explicit configuration (SC-5089 review): a link the plugin builds must
// have a real source, never a hardcoded guess. JIRA_SITE unset or malformed means no ticket link — the title stays
// text. Validated: https, no credentials, no query (where tokens travel), no path.
export const jiraSite = (): string | null => {
  const raw = process.env.JIRA_SITE?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
    if (u.pathname && u.pathname !== "/") return null;
    return u.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
};
export const ticketLink = (key: string): { key: string; url: string } | null => {
  const site = jiraSite();
  return site ? { key, url: `${site}/browse/${key}` } : null;
};

// A result link is never invented: it must appear in the command's own output (a PR URL `gh` printed, a Jira browse URL)
// or be the file path of a completed Write/Edit. Anything carrying credentials or a query (where tokens travel) is
// dropped, and only https with the default port survives.
const URL_RE = /https:\/\/[^\s"'<>\\`|]+/g;
function linkFromUrl(raw: string): PlanLink | null {
  const u = new URL(raw.replace(/[.,;:)\]}]+$/, "")); // trailing prose punctuation is not part of the URL
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null;
  if (u.port && u.port !== "443") return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (u.hostname === "github.com" || u.hostname === "www.github.com") {
    if (segs.length === 4 && /^\d+$/.test(segs[3]) && (segs[2] === "pull" || segs[2] === "issues")) {
      const repo = `${segs[0]}/${segs[1]}`;
      return segs[2] === "pull"
        ? { kind: "pr", href: u.href, label: `PR #${segs[3]} ${repo}` }
        : { kind: "ticket", href: u.href, label: `Issue #${segs[3]} ${repo}` };
    }
    return null;
  }
  // A browse URL is a result only when the command printed it on a real Jira host: *.atlassian.net, or the host of the
  // explicitly configured site (jiraSite is already validated, null without JIRA_SITE).
  const siteHost = jiraSite() ? new URL(jiraSite()!).hostname : "";
  if (segs.length === 2 && segs[0] === "browse" && /^[A-Z][A-Z0-9]+-\d+$/.test(segs[1]) && (u.hostname.endsWith(".atlassian.net") || u.hostname === siteHost)) {
    return { kind: "ticket", href: u.href, label: segs[1] };
  }
  return null;
}

// URLs only from a shell command's output: the result the command produced. Not from the command line (the agent typed
// it) and not from fetched web content (it could plant a link).
function linksFromCommand(item: Item): PlanLink[] {
  const d = (item.detail ?? {}) as Record<string, unknown>;
  const out: PlanLink[] = [];
  if (d.type === "shell" && typeof d.output === "string") {
    const seen = new Set<string>();
    for (const raw of d.output.match(URL_RE) ?? []) {
      try {
        const link = linkFromUrl(raw);
        if (link && !seen.has(link.href)) {
          seen.add(link.href);
          out.push(link);
        }
      } catch {
        // not a parseable URL: prose that starts with https://
      }
    }
  } else if ((d.type === "write" || d.type === "edit") && item.status === "completed" && typeof d.filePath === "string" && d.filePath.startsWith("/")) {
    out.push({ kind: "file", href: d.filePath, label: d.filePath.split("/").pop() || d.filePath });
  }
  return out.slice(0, MAX_LINKS);
}

/** Drops the file links whose path no longer exists: a link shown is a file that is there (SC-5089). */
export async function verifyFileLinks(data: PlanData): Promise<void> {
  for (const t of data.tasks) {
    if (!t.links?.some((l) => l.kind === "file")) continue;
    const keep: PlanLink[] = [];
    for (const l of t.links) {
      if (l.kind !== "file") keep.push(l);
      else {
        try {
          if ((await stat(l.href)).isFile()) keep.push(l);
        } catch {
          // deleted since the command wrote it: not shown
        }
      }
    }
    if (keep.length) t.links = keep;
    else delete t.links;
  }
}

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
      const items = item.items as Array<{
        id?: string;
        text: string;
        status?: Task["status"];
        completed?: boolean;
        activeForm?: string;
        blockedBy?: unknown;
      }>;
      this.tasks = items.map((t) => ({
        key: t.id ?? t.text,
        text: t.text,
        activeForm: t.activeForm,
        status: t.status ?? (t.completed ? "completed" : "pending"),
        ...(Array.isArray(t.blockedBy) && t.blockedBy.length ? { blockedBy: t.blockedBy.map(String) } : {}),
      }));
      return true;
    }
    if (item.type !== "tool_call" || TASK_TOOLS.has(String(item.name)) || ownCardElsewhere(item.name)) return false;
    const callId = String(item.callId);
    const key = this.owner.get(callId) ?? this.tasks.find((t) => t.status === "in_progress")?.key ?? OTHER;
    this.owner.set(callId, key);
    const bucket = this.calls.get(key) ?? new Map<string, Call>();
    const links = linksFromCommand(item);
    bucket.set(callId, {
      label: label(item),
      detail: detail(item),
      status: item.status as Call["status"],
      ...(links.length ? { links } : {}),
    });
    this.calls.set(key, bucket);
    return true;
  }

  data(): PlanData | null {
    // The row carries each command without its links (they would repeat under the task and bloat the cap) and the
    // task's links once, deduplicated, aggregated from its commands.
    const calls = (key: string) => [...(this.calls.get(key)?.values() ?? [])].slice(-MAX_CALLS);
    const commands = (key: string) => calls(key).map(({ links: _links, ...c }) => c);
    const links = (key: string) => {
      const seen = new Map<string, PlanLink>();
      for (const c of calls(key)) for (const l of c.links ?? []) if (!seen.has(l.href)) seen.set(l.href, l);
      return [...seen.values()].slice(0, MAX_LINKS);
    };
    const other = calls(OTHER);
    const tasks: PlanData["tasks"] = this.tasks.map((t) => {
      const taskLinks = links(t.key);
      return { ...t, commands: commands(t.key), ...(taskLinks.length ? { links: taskLinks } : {}) };
    });
    if (other.length) {
      const otherLinks = links(OTHER);
      tasks.unshift({ key: OTHER, text: "", status: "other", commands: commands(OTHER), ...(otherLinks.length ? { links: otherLinks } : {}) }); // the client words it
    }
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
