import { execFile } from "node:child_process";
import { createReadStream, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { anchorSchema, type Anchor } from "../shared/anchor.ts";
import { splitPlans } from "../shared/plan.ts";
import { planFromTasks } from "./tasks.ts";

const run = promisify(execFile);
// CONTRACT: file.paseo-plan.anchor.v1 (~/.local/state/paseo-plan/anchor-<agentId>.json, shape in shared/anchor.ts)
const ANCHOR_DIR = join(homedir(), ".local", "state", "paseo-plan");
const JIRA = join(homedir(), ".local", "libexec", "x86-host-runtime", "jira_rest.py");
const TASKS = join(homedir(), ".claude", "tasks");
const KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const KEYS = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Plan = Omit<Anchor, "guard">;

// tag markup out: a prompt sent by another session comes wrapped in <paseo-system source-agent-title="<its ticket> …">
const bare = (text: string) => text.replace(/<[^>]*>/g, " ");

/** The key a text names most (a tie goes to the first that appears): a plan of six tasks naming its ticket outweighs one line naming a dependency. */
function dominantKey(text: string): string | null {
  const counts = new Map<string, number>();
  for (const m of bare(text).matchAll(KEYS)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  return counts.size ? [...counts].sort(([, a], [, b]) => b - a)[0][0] : null;
}

/**
 * The ticket of the plan a session is running: the key its current plan names most, else the worktree it works in
 * (`.claude/worktrees/<KEY>-…`), else its branch, else the key its prompts name last, else the first of its brief. The
 * brief alone is not enough: it names a related ticket first as often as its own (SC-5282, INFRA-1219 vs INFRA-1243).
 */
export function ticketKey(cwd: string, branch: string, brief: string, plan = "", later = ""): string | null {
  return (
    dominantKey(plan) ??
    /\.claude\/worktrees\/([A-Z][A-Z0-9]+-\d+)(?![\d])/.exec(cwd)?.[1] ??
    /^([A-Z][A-Z0-9]+-\d+)(?![\d])/.exec(branch)?.[1] ??
    bare(later).match(KEYS)?.at(-1) ??
    KEY.exec(bare(brief))?.[1] ??
    null
  );
}

// A markdown heading (`## Objetivo`) or a Jira wiki one (`h2. Objetivo`, descriptions written in wiki markup): level and title.
const heading = (line: string) => {
  const m = /^(?:(#{1,6})|h([1-6])\.)\s+(.*)$/.exec(line);
  return m && { level: m[1]?.length ?? Number(m[2]), title: m[3] };
};

/** The body of the first section whose title matches, up to the next heading of the same or a higher level. */
function section(md: string, title: RegExp): string | null {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => title.test(heading(l)?.title ?? "\0"));
  if (start < 0) return null;
  const level = heading(lines[start])!.level;
  const end = lines.findIndex((l, i) => i > start && (heading(l)?.level ?? 7) <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// Top-level list items only: an indented line is detail of the item above, not a criterion of its own.
const items = (body: string) =>
  body.split("\n").flatMap((l) => {
    const m = /^(?:[-*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/.exec(l);
    return m ? [{ checked: Boolean(m[1]?.trim()), text: m[2].trim() }] : [];
  });

/** The plan a markdown text carries: its criteria (`## Criterios…` or `## Plan`), objective and what is out of scope. */
export function planFrom(md: string, ticketKey: string | null = null): Plan {
  const seen = new Set<string>();
  const criterios = items(section(md, /^(criterios|plan\b|acceptance criteria)/i) ?? "")
    .filter((i) => !seen.has(i.text) && seen.add(i.text))
    .map((i) => ({ texto: i.text, como_se_verifica: "", status: i.checked ? "verificada" : "abierta", evidencia: "" }));
  const objetivo = (section(md, /^objetivo/i) ?? "").split(/\n\s*\n/).map((p) => p.trim()).find((p) => p && !p.startsWith("Repo:")) ?? "";
  const fuera = section(md, /^fuera de alcance/i) ?? "";
  const fuera_de_alcance = items(fuera).length ? items(fuera).map((i) => i.text) : fuera.split("\n").map((l) => l.trim()).filter(Boolean);
  return { ticketKey, objetivo, criterios, fuera_de_alcance };
}

/** What `jira_rest.py criterios <KEY>` prints (contract cli.jira-rest.criterios.v1): each criterion with its state read as the Done gate reads it. */
export interface Ticket {
  resumen: string;
  descripcion: string;
  spec: string;
  criterios: Array<{ texto: string; status: string; evidencia: string }>;
}

// The CTO's account: a live session reads its ticket as cto, and jira_rest.py in strict mode refuses a read without a role (spike, SC-4804).
async function jira(key: string): Promise<Ticket> {
  const { stdout } = await run("python3", [JIRA, "criterios", key], { env: { ...process.env, JIRA_ROL: "cto" }, timeout: 60_000, maxBuffer: 4 << 20 });
  return JSON.parse(stdout);
}

const branchOf = (cwd: string) => run("git", ["-C", cwd, "branch", "--show-current"], { timeout: 5_000 }).then((r) => r.stdout.trim(), () => "");

// What the harness injects as a user line and is not the user speaking: the supervisor's EVENTO lines and the compaction
// recap speak of other sessions' tickets. A <task-notification> stays: it reports work of THIS session.
// shortcut: <los inyectados se reconocen por su marca>, <canal tipado del host cuando exista>
const INJECTED = [/^\(supervisor/, /^This session is being continued/, /^\[Request interrupted/];

/** What the user said in the session, in order, from Claude Code's transcript. */
export async function userPrompts(cwd: string, sessionId: string | null, root = join(homedir(), ".claude", "projects")): Promise<string[]> {
  const out: string[] = [];
  if (!sessionId || !SESSION.test(sessionId)) return out;
  const lines = createInterface({ input: createReadStream(join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let e: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type !== "user" || e.isMeta) continue;
      const c = e.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : "";
      if (text.trim() && !INJECTED.some((re) => re.test(text.trim()))) out.push(text);
    }
  } catch {
    // no transcript yet: the session has not started
  } finally {
    lines.close();
  }
  return out;
}

/** The text of the plan the session is running (its latest epoch of task files), where a plan names its own ticket. */
async function planText(sessionId: string | null, root: string): Promise<string> {
  const files = sessionId ? await planFromTasks(sessionId, root).catch(() => null) : null;
  return files ? splitPlans(files).current.tasks.map((t) => t.text).join("\n") : "";
}

/**
 * The plan of the session's ticket — the one of the plan in progress, see `ticketKey` — with its criteria and their state
 * and evidence as the Done gate reads them (`00-spec.md`, else the description; `jira_rest.py criterios`), its objective
 * (`## Objetivo` of the description, else of the spec, else the summary) and what is out of scope. Without ticket
 * criteria, the `## Plan`/`## Criterios` of the worktree's CLAUDE.md, else of the brief. Null with neither a ticket nor
 * criteria. Jira not answering throws: the caller keeps the anchor it had.
 */
export async function buildPlan(cwd: string, sessionId: string | null, read = jira, tasksRoot = TASKS): Promise<Plan | null> {
  const [brief = "", ...later] = await userPrompts(cwd, sessionId);
  const key = ticketKey(cwd, await branchOf(cwd), brief, await planText(sessionId, tasksRoot), later.join("\n"));
  let plan: Plan | null = null;
  if (key) {
    const t = await read(key);
    const [desc, spec] = [planFrom(t.descripcion), planFrom(t.spec)];
    plan = {
      ticketKey: key,
      objetivo: desc.objetivo || spec.objetivo || t.resumen,
      criterios: t.criterios.map((c) => ({ texto: c.texto, como_se_verifica: "", status: c.status, evidencia: c.evidencia })),
      fuera_de_alcance: spec.fuera_de_alcance.length ? spec.fuera_de_alcance : desc.fuera_de_alcance,
    };
  }
  if (plan?.criterios.length) return plan;
  for (const md of [await readFile(join(cwd, "CLAUDE.md"), "utf8").catch(() => ""), brief]) {
    const local = planFrom(md, key);
    if (local.criterios.length) return { ...local, objetivo: local.objetivo || plan?.objetivo || "" };
  }
  return plan;
}

const fileOf = (agentId: string, dir: string) => join(dir, `anchor-${agentId}.json`);

export function readAnchor(agentId: string, dir = ANCHOR_DIR): Anchor | null {
  try {
    const parsed = anchorSchema.safeParse(JSON.parse(readFileSync(fileOf(agentId, dir), "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Synchronous read-modify-write: a refresh and a guard switch never interleave, and the rename means a reader never sees half a file.
function write(agentId: string, anchor: Anchor, dir: string): Anchor {
  mkdirSync(dir, { recursive: true });
  const file = fileOf(agentId, dir);
  writeFileSync(`${file}.tmp`, JSON.stringify(anchor, null, 2));
  renameSync(`${file}.tmp`, file);
  return anchor;
}

/** A refreshed plan replaces the anchor and keeps its guard. */
export const saveAnchor = (agentId: string, plan: Plan, dir = ANCHOR_DIR): Anchor =>
  write(agentId, { ...plan, guard: readAnchor(agentId, dir)?.guard === true }, dir);

/** Switches «Garantizar plan»; an anchor with no criteria is left off. Null with no anchor. */
export function setGuard(agentId: string, guard: boolean, dir = ANCHOR_DIR): Anchor | null {
  const anchor = readAnchor(agentId, dir);
  if (!anchor || (guard && !anchor.criterios.length)) return anchor;
  return write(agentId, { ...anchor, guard }, dir);
}
