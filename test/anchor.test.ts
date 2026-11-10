import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, planFrom, readAnchor, saveAnchor, setGuard, ticketKey, userPrompts, type Ticket } from "../server/anchor.ts";

const SPEC = `Rol: supervisor · Estado: BORRADOR

# SC-1 — título

## Objetivo
Que la pastilla enseñe el plan.

Repo: ~/src/paseo-plan

## Criterios de aceptación
- [ ] Uno
- [x] Dos
  - detalle de dos, no es un criterio

## Fuera de alcance
El Stop hook.

## Descripción original
## Criterios de aceptación
- [ ] Uno
`;

test("the ticket comes from the plan in progress, else the worktree, else the branch, else the prompts (SC-5282)", () => {
  assert.equal(ticketKey("/r/.claude/worktrees/SC-4804-ancla", "main", "SC-1"), "SC-4804");
  assert.equal(ticketKey("/r", "DGX-12-x", "SC-1"), "DGX-12");
  assert.equal(ticketKey("/r", "main", "Historia en vivo SC-4804 (y SC-4803)"), "SC-4804");
  assert.equal(ticketKey("/r", "main", "sin ticket"), null);
  const sent = '<paseo-system version="1" kind="agent-message" source-agent-title="SC-4804 · Pastilla">\nPrueba de SC-4805\n</paseo-system>';
  assert.equal(ticketKey("/r", "main", sent), "SC-4805", "the launching session's title is not this session's ticket");
  // the plan in progress names its own ticket: the brief named a related one first (INFRA-1219 vs INFRA-1243)
  assert.equal(ticketKey("/r", "main", "montar el fallback, parte de INFRA-1219", "Medir ComfyUI INFRA-1243\nInventariar el arbiter INFRA-1243"), "INFRA-1243");
  // a dependency named once in the plan does not outweigh the ticket the plan is about
  assert.equal(ticketKey("/r", "main", "SC-1", "Hacer SC-2\nOtra cosa\nY otra"), "SC-2");
  // with no plan and no worktree, the key the session names last beats the one its brief named first
  assert.equal(ticketKey("/r", "main", "SC-1 x", "", "reviso lo de SC-1 y abro SC-2"), "SC-2");
  // a declared worktree still wins over prose
  assert.equal(ticketKey("/r/.claude/worktrees/SC-4804-x", "main", "SC-1", "", "SC-2"), "SC-4804");
});

test("a spec gives its first criteria section, top-level items only, with the box as status; objective and out of scope", () => {
  assert.deepEqual(planFrom(SPEC, "SC-1"), {
    ticketKey: "SC-1",
    objetivo: "Que la pastilla enseñe el plan.",
    criterios: [
      { texto: "Uno", como_se_verifica: "", status: "abierta", evidencia: "" },
      { texto: "Dos", como_se_verifica: "", status: "verificada", evidencia: "" },
    ],
    fuera_de_alcance: ["El Stop hook."],
  });
  assert.deepEqual(planFrom("# X\n## Plan\n1. a\n2) b\n").criterios.map((c) => c.texto), ["a", "b"]);
  assert.deepEqual(planFrom("nada").criterios, []);
});

const TICKET = (over: Partial<Ticket> = {}): Ticket => ({ resumen: "El resumen", descripcion: "", spec: "", criterios: [], ...over });

test("with a ticket, criteria and their state come from jira_rest criterios; else the worktree's CLAUDE.md; Jira failing throws", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anchor-"));
  const wt = join(cwd, ".claude", "worktrees", "SC-1-x");
  await mkdir(wt, { recursive: true });
  const asked: string[] = [];
  const read = (t: Ticket) => async (key: string) => (asked.push(key), t);
  const criterios = [{ texto: "Uno", status: "verificada", evidencia: "`npm test` → 24/24" }, { texto: "Dos", status: "abierta", evidencia: "" }];

  const plan = (await buildPlan(wt, null, read(TICKET({ spec: SPEC, criterios }))))!;
  assert.deepEqual(asked, ["SC-1"]);
  assert.deepEqual(plan.criterios, [
    { texto: "Uno", como_se_verifica: "", status: "verificada", evidencia: "`npm test` → 24/24" },
    { texto: "Dos", como_se_verifica: "", status: "abierta", evidencia: "" },
  ]);
  assert.deepEqual([plan.objetivo, plan.fuera_de_alcance], ["Que la pastilla enseñe el plan.", ["El Stop hook."]]);

  await writeFile(join(wt, "CLAUDE.md"), "## Criterios\n- Del CLAUDE.md\n");
  const local = (await buildPlan(wt, null, read(TICKET())))!;
  assert.deepEqual([local.ticketKey, local.objetivo, local.criterios[0].texto], ["SC-1", "El resumen", "Del CLAUDE.md"]);

  assert.equal(await buildPlan(cwd, null, read(TICKET())), null); // no ticket and no criteria: no anchor
  await assert.rejects(buildPlan(wt, null, async () => Promise.reject(new Error("jira down"))));
});

test("the objective is always there: the description's, else the spec's, else the summary (SC-4805, INFRA-1196)", async () => {
  const wt = join(await mkdtemp(join(tmpdir(), "anchor-")), ".claude", "worktrees", "SC-4805-x");
  await mkdir(wt, { recursive: true });
  const criterios = [{ texto: "c", status: "abierta", evidencia: "" }];
  const objetivo = async (t: Partial<Ticket>) => (await buildPlan(wt, null, async () => TICKET({ criterios, ...t })))!.objetivo;
  // SC-4805: the spec has no «## Objetivo»; the description has it, followed by «## Por qué»
  assert.equal(
    await objetivo({ spec: "# SC-4805 · Supervisor\n\nHistoria E.\n\n## Criterios de aceptación\n- [ ] c\n", descripcion: "Historia E.\n## Objetivo\nEn la compañía el supervisor solo autoenvía lo que está en el plan\n## Por qué\nDGX-674.\n" }),
    "En la compañía el supervisor solo autoenvía lo que está en el plan",
  );
  // INFRA-1196: the spec says «# Qué y por qué», the description is Jira wiki markup («h2. Objetivo»)
  assert.equal(
    await objetivo({ spec: "# Qué y por qué\n\nQue los agentes…\n\n# Criterios de aceptación\n- [ ] c\n", descripcion: "h2. Objetivo\nQue los agentes puedan editar desde el MCP socialmedia\nh2. Contexto / evidencia\n- Caption\n" }),
    "Que los agentes puedan editar desde el MCP socialmedia",
  );
  assert.equal(await objetivo({ spec: "## Objetivo\nDel spec\n" }), "Del spec");
  assert.equal(await objetivo({}), "El resumen");
});

test("the prompts are the user's own: the supervisor's lines, the recap and the interruptions are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-tx-"));
  const sid = "6a7c0e2f-1460-4f8c-b902-027554ee8767";
  const dir = join(root, "-r--claude-x");
  await mkdir(dir);
  const lines = [
    { type: "attachment" },
    { type: "user", isMeta: true, message: { content: "caveat" } },
    { type: "user", message: { content: [{ type: "text", text: "Historia SC-9" }] } },
    { type: "user", message: { content: "(supervisor; no es un mensaje de Dani) EVENTO: ci org/repo#1 → verde, sigue SC-7" } },
    { type: "user", message: { content: "<task-notification>\n<result>sweep de SC-9 limpio</result>" } },
    { type: "user", message: { content: "This session is being continued from a previous conversation (SC-9)" } },
    { type: "user", message: { content: "[Request interrupted by user]" } },
    { type: "user", message: { content: "después" } },
  ];
  await writeFile(join(dir, `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.deepEqual(await userPrompts("/r/.claude/x", sid, root), ["Historia SC-9", "<task-notification>\n<result>sweep de SC-9 limpio</result>", "después"]);
  assert.deepEqual(await userPrompts("/r/.claude/x", "../x", root), []);
  assert.deepEqual(await userPrompts("/otra", sid, root), []);
});

test("the anchor is the ticket of the plan in progress, not the one the brief named first (SC-5282)", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anchor-"));
  const sid = "1b2c3d4e-5f60-4172-8394-a5b6c7d8e9f0";
  const tx = join(await mkdtemp(join(tmpdir(), "anchor-tx-")), cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(tx, { recursive: true });
  await writeFile(join(tx, `${sid}.jsonl`), JSON.stringify({ type: "user", message: { content: "Objetivo: el fallback de STT, parte de INFRA-1219" } }));
  const tasks = join(await mkdtemp(join(tmpdir(), "anchor-tasks-")), sid);
  await mkdir(tasks, { recursive: true });
  await writeFile(join(tasks, "7.json"), JSON.stringify({ id: "7", subject: "Inventariar ComfyUI (INFRA-1243)", status: "completed" }));
  await writeFile(join(tasks, "8.json"), JSON.stringify({ id: "8", subject: "Medir ComfyUI en mac-casa, INFRA-1243", status: "in_progress" }));
  const asked: string[] = [];
  const plan = (await buildPlan(cwd, sid, async (key) => (asked.push(key), TICKET({ criterios: [{ texto: "c", status: "abierta", evidencia: "" }] })), join(tasks, "..")))!;
  assert.deepEqual(asked, ["INFRA-1243"], "el plan en marcha manda sobre el brief");
  assert.equal(plan.ticketKey, "INFRA-1243");
});

test("a refresh keeps the guard; the guard does not arm without criteria", async () => {
  const dir = await mkdtemp(join(tmpdir(), "anchor-dir-"));
  const plan = planFrom(SPEC, "SC-1");
  assert.equal(saveAnchor("a1", plan, dir).guard, false);
  assert.equal(setGuard("a1", true, dir)?.guard, true);
  assert.equal(saveAnchor("a1", plan, dir).guard, true);
  assert.equal(JSON.parse(await readFile(join(dir, "anchor-a1.json"), "utf8")).guard, true);
  assert.equal(setGuard("a1", false, dir)?.guard, false);

  saveAnchor("a2", { ...plan, criterios: [] }, dir);
  assert.equal(setGuard("a2", true, dir)?.guard, false);
  assert.equal(setGuard("nadie", true, dir), null);
  assert.equal(readAnchor("nadie", dir), null);
});
