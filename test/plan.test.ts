import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PlanState, ticketLink, verifyFileLinks } from "../server/plan.ts";

const todo = (...s: string[]) => ({ type: "todo", items: s.map((status, i) => ({ id: String(i), text: `t${i}`, status })) });
const call = (callId: string, command: string, status = "running", name = "Bash") => ({ type: "tool_call", callId, name, status, detail: { type: "shell", command } });
const shell = (callId: string, command: string, output: string, status = "completed") => ({ type: "tool_call", callId, name: "Bash", status, detail: { type: "shell", command, output } });

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

test("the pill counts the latest plan; the earlier ones come apart, oldest first", async () => {
  const { planProgressLabel, splitPlans } = await import("../shared/plan.ts");
  const t = (key: string, status: "completed" | "pending" | "other", plan?: number) => ({ key, text: key, status, commands: [], ...(plan === undefined ? {} : { plan }) });
  const data = { tasks: [t("_other", "other"), t("1", "completed", 0), t("2", "completed", 1), t("3", "completed", 2), t("4", "pending", 2)] };
  assert.equal(planProgressLabel(data), "Plan 1/2");
  const { current, earlier } = splitPlans(data);
  assert.deepEqual(current.tasks.map((x) => x.key), ["_other", "3", "4"]);
  assert.deepEqual(earlier.map((g) => g.map((x) => x.key)), [["1"], ["2"]]);
  assert.deepEqual(splitPlans({ tasks: [t("1", "pending")] }), { current: { tasks: [t("1", "pending")] }, earlier: [] });
});

test("blockedBy survives the live fold only when it is explicit", () => {
  const p = new PlanState();
  p.observe({ type: "todo", items: [{ id: "1", text: "a", status: "pending", blockedBy: ["2"] }, { id: "2", text: "b", status: "pending", blockedBy: [] }] });
  const d = p.data()!;
  assert.deepEqual(d.tasks[0].blockedBy, ["2"]);
  assert.equal(d.tasks[1].blockedBy, undefined); // an empty list is no information: the field stays out
});

test("a PR or Jira URL a shell command printed becomes a task link; credentials, queries and foreign hosts never do", () => {
  const p = new PlanState();
  p.observe(todo("in_progress"));
  p.observe(shell("g", "gh pr create", "https://github.com/pocharlies-org/paseo-plan/pull/99\nhttps://u:pass@github.com/o/r/pull/1\nhttps://github.com/o/r/pull/2?token=abc\nhttp://github.com/o/r/pull/3\nhttps://evil.example/o/r/pull/4"));
  p.observe(shell("j", "jira show", "Done. See https://e-dani.atlassian.net/browse/SC-5089."));
  p.observe(shell("i", "gh issue view", "https://github.com/o/r/issues/5"));
  p.observe({ type: "tool_call", callId: "f", name: "WebFetch", status: "completed", detail: { type: "fetch", url: "https://example.com", result: "https://github.com/x/y/pull/1" } }); // web content could plant a link: never a result
  assert.deepEqual(p.data()!.tasks[0].links, [
    { kind: "pr", href: "https://github.com/pocharlies-org/paseo-plan/pull/99", label: "PR #99 pocharlies-org/paseo-plan" },
    { kind: "ticket", href: "https://e-dani.atlassian.net/browse/SC-5089", label: "SC-5089" },
    { kind: "ticket", href: "https://github.com/o/r/issues/5", label: "Issue #5 o/r" },
  ]);
});

test("a completed Write names its file as a result link; a running one does not", () => {
  const p = new PlanState();
  p.observe(todo("in_progress"));
  p.observe({ type: "tool_call", callId: "w", name: "Write", status: "running", detail: { type: "write", filePath: "/srv/app/x.ts", content: "" } });
  assert.equal(p.data()!.tasks[0].links, undefined);
  p.observe({ type: "tool_call", callId: "w", name: "Write", status: "completed", detail: { type: "write", filePath: "/srv/app/x.ts", content: "code" } });
  assert.deepEqual(p.data()!.tasks[0].links, [{ kind: "file", href: "/srv/app/x.ts", label: "x.ts" }]);
});

test("verifyFileLinks keeps the files that are there and drops the ones that are not", async () => {
  const root = await mkdtemp(join(tmpdir(), "plan-links-"));
  const real = join(root, "x.ts");
  await writeFile(real, "code");
  const data = {
    tasks: [
      {
        key: "1",
        text: "t",
        status: "completed" as const,
        commands: [],
        links: [
          { kind: "file" as const, href: real, label: "x.ts" },
          { kind: "file" as const, href: join(root, "gone.ts"), label: "gone.ts" },
          { kind: "pr" as const, href: "https://github.com/o/r/pull/1", label: "PR #1 o/r" },
        ],
      },
    ],
  };
  await verifyFileLinks(data);
  assert.deepEqual(data.tasks[0].links!.map((l) => l.href), [real, "https://github.com/o/r/pull/1"]);
});

test("the ticket link exists only with an explicit valid JIRA_SITE: no default, no invented URL (SC-5089 review)", () => {
  delete process.env.JIRA_SITE;
  assert.equal(ticketLink("SC-5089"), null); // no config: no link, the title stays plain text
  const withSite = (site: string) => {
    process.env.JIRA_SITE = site;
    try {
      return ticketLink("SC-5089");
    } finally {
      delete process.env.JIRA_SITE;
    }
  };
  assert.deepEqual(withSite("https://jira.example.test/"), { key: "SC-5089", url: "https://jira.example.test/browse/SC-5089" });
  assert.equal(withSite("http://jira.example.test"), null); // not https
  assert.equal(withSite("https://u:pass@jira.example.test"), null); // credentials
  assert.equal(withSite("https://jira.example.test/?token=abc"), null); // query: where tokens travel
  assert.equal(withSite("https://jira.example.test/sprints"), null); // a path is not a site
  assert.equal(withSite("https://evil.example/../jira.example.test"), null); // the path makes it not a bare site
  assert.equal(withSite("nope"), null); // not a URL at all
});

test("the last failed command is the error kept visible, also in a task that is not the active one", async () => {
  const { lastFailedCommand } = await import("../shared/plan.ts");
  const c = (status: "running" | "completed" | "failed", label = status) => ({ label, status });
  assert.equal(lastFailedCommand([c("completed"), c("failed", "a"), c("completed"), c("failed", "b")])?.label, "b");
  assert.equal(lastFailedCommand([c("running"), c("completed")]), undefined); // no error: nothing extra to keep open
  assert.equal(lastFailedCommand([]), undefined);
});

test("task states come from explicit data: blocked only with an unmet blockedBy, never from the text", async () => {
  const { taskState } = await import("../shared/plan.ts");
  const t = (key: string, status: "pending" | "in_progress" | "completed" | "other", extra: Record<string, unknown> = {}) => ({ key, text: key, status, commands: [], ...extra });
  const blocker = t("2", "pending");
  const waiting = t("1", "pending", { blockedBy: ["2"] });
  assert.equal(taskState(waiting, [waiting, blocker]), "blocked");
  assert.equal(taskState(waiting, [waiting, t("2", "completed")]), "waiting"); // the blocker is done: waiting, not blocked
  assert.equal(taskState(t("3", "pending", { text: "bloqueado por la CI" }), []), "waiting"); // words in the text prove nothing
  assert.equal(taskState(t("4", "pending", { blockedBy: ["no-existe"] }), []), "blocked"); // a blocker not completed is not completed
  assert.equal(taskState(t("5", "in_progress"), []), "running");
  assert.equal(taskState(t("6", "completed"), []), "completed");
  assert.equal(taskState(t("7", "other"), []), "other");
});

test("the pill label pairs progress with the active task, cut short; the title keeps it whole", async () => {
  const { planPillLabel } = await import("../shared/plan.ts");
  const t = (key: string, status: "pending" | "in_progress" | "completed", extra: Record<string, unknown> = {}) => ({ key, text: key, status, commands: [], ...extra });
  assert.deepEqual(planPillLabel({ tasks: [t("1", "completed"), t("2", "pending")] }), { label: "Plan 1/2", title: "Plan 1/2" }); // no active task: progress alone
  const long = "x".repeat(50);
  const r = planPillLabel({ tasks: [t("1", "completed"), t("2", "in_progress", { text: long }), t("3", "pending")] });
  assert.equal(r.label, `Plan 1/3 · ${"x".repeat(39)}…`);
  assert.equal(r.title, `Plan 1/3 · ${long}`);
  assert.deepEqual(planPillLabel({ tasks: [t("2", "in_progress", { text: "hacer X", activeForm: "Haciendo X" })] }), { label: "Plan 0/1 · Haciendo X", title: "Plan 0/1 · Haciendo X" });
});

test("a reread from the files keeps the links and the ticket the live row showed", async () => {
  const { keepCommands } = await import("../shared/plan.ts");
  const link = { kind: "pr" as const, href: "https://github.com/o/r/pull/9", label: "PR #9 o/r" };
  const live = { tasks: [{ key: "a", text: "t1", status: "in_progress" as const, commands: [], links: [link] }], ticket: { key: "SC-1", url: "https://x/browse/SC-1" } };
  const files = { tasks: [{ key: "1", text: "t1", status: "completed" as const, commands: [] }] };
  const kept = keepCommands(files, live);
  assert.deepEqual(kept.tasks[0].links, [link]);
  assert.deepEqual(kept.ticket, live.ticket);
  assert.equal(keepCommands(files, null).ticket, undefined);
});
