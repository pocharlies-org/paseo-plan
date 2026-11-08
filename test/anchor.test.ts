import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPlan, firstPrompt, planFrom, readAnchor, saveAnchor, setGuard, ticketKey } from "../server/anchor.ts";

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

test("the ticket comes from the worktree, else the branch, else the first key of the first prompt", () => {
  assert.equal(ticketKey("/r/.claude/worktrees/SC-4804-ancla", "main", "SC-1"), "SC-4804");
  assert.equal(ticketKey("/r", "DGX-12-x", "SC-1"), "DGX-12");
  assert.equal(ticketKey("/r", "main", "Historia en vivo SC-4804 (y SC-4803)"), "SC-4804");
  assert.equal(ticketKey("/r", "main", "sin ticket"), null);
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

test("sources in order: 00-spec.md, then the description, then the worktree's CLAUDE.md; Jira failing throws", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "anchor-"));
  const wt = join(cwd, ".claude", "worktrees", "SC-1-x");
  await mkdir(wt, { recursive: true });
  const calls: string[][] = [];
  const jira = (spec: string | null, ver: string) => async (args: string[]) => (calls.push(args), args[0] === "get" ? spec : ver);

  assert.equal((await buildPlan(wt, null, jira(SPEC, "")))?.criterios.length, 2);
  assert.deepEqual(calls, [["get", "SC-1", "00-spec.md"]]);

  const desc = (await buildPlan(wt, null, jira(null, "SC-1 · El resumen\n## Criterios de aceptación\n- [ ] De la descripción\n")))!;
  assert.deepEqual([desc.objetivo, desc.criterios[0].texto], ["El resumen", "De la descripción"]);

  await writeFile(join(wt, "CLAUDE.md"), "## Criterios\n- Del CLAUDE.md\n");
  const local = (await buildPlan(wt, null, jira(null, "SC-1 · El resumen\n")))!;
  assert.deepEqual([local.ticketKey, local.objetivo, local.criterios[0].texto], ["SC-1", "El resumen", "Del CLAUDE.md"]);

  assert.equal(await buildPlan(cwd, null, jira(null, "")), null); // no ticket and no criteria: no anchor
  await assert.rejects(buildPlan(wt, null, async () => Promise.reject(new Error("jira down"))));
});

test("the first prompt is the first real user line of the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "anchor-tx-"));
  const sid = "6a7c0e2f-1460-4f8c-b902-027554ee8767";
  await mkdir(join(root, "-r--claude-x"));
  const lines = [
    { type: "attachment" },
    { type: "user", isMeta: true, message: { content: "caveat" } },
    { type: "user", message: { content: [{ type: "text", text: "Historia SC-9" }] } },
    { type: "user", message: { content: "después" } },
  ];
  await writeFile(join(root, "-r--claude-x", `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(await firstPrompt("/r/.claude/x", sid, root), "Historia SC-9");
  assert.equal(await firstPrompt("/r/.claude/x", "../x", root), "");
  assert.equal(await firstPrompt("/otra", sid, root), "");
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
