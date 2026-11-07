import { test } from "node:test";
import assert from "node:assert/strict";
import { registerPlanPills, type PlanPillClient } from "../client/pills.ts";

const planRow = (statuses: Array<"pending" | "in_progress" | "completed">) => ({
  type: "plugin",
  id: "plan",
  kind: "plan-progress",
  version: 1,
  data: { tasks: statuses.map((status, i) => ({ key: String(i), text: `t${i}`, status, commands: [] })) },
});

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  provider: "claude",
  workspaceId: "w1",
  status: "running",
  persistence: { provider: "claude", sessionId: `s-${id}` },
  ...extra,
});

interface Pill {
  contrib: { agentId: string; workspaceId: string; button: { label?: string; behavior: { kind: string } } };
  updates: Array<{ label?: string }>;
  removed: boolean;
}
interface Timeline {
  rows: unknown[];
  handlers: ((e: { agentId: string; event: unknown }) => void)[];
  released: boolean;
}

function harness(opts: { holdList?: boolean; holdRead?: boolean } = {}) {
  const pills: Pill[] = [];
  const reads: string[] = [];
  const timelines = new Map<string, Timeline>();
  let observers: Array<{ snapshot(s: { entries: unknown[] }): void; update(m: unknown): void }> = [];
  let agentsReleased = false;
  let aborted = false;
  let resolveList: () => void = () => {};
  const listGate = new Promise<void>((resolve) => {
    resolveList = resolve;
  });
  let readGate: Promise<void> = Promise.resolve();
  let resolveRead: () => void = () => {};
  if (opts.holdRead) {
    readGate = new Promise<void>((resolve) => {
      resolveRead = resolve;
    });
  }
  const timelineFor = (id: string) => {
    if (!timelines.has(id)) timelines.set(id, { rows: [], handlers: [], released: false });
    return timelines.get(id)!;
  };
  const fake = {
    // plan.get answers from the agent's task files; here, the last plan the fake timeline holds
    async rpc(_contract: unknown, input: { sessionId: string }) {
      reads.push(input.sessionId);
      await readGate;
      const last = timelineFor(input.sessionId.slice(2)).rows.at(-1) as { data?: unknown } | undefined;
      return { plan: last?.data ?? null };
    },
    addComposerPill(contrib: Pill["contrib"] & Record<string, unknown>) {
      const pill: Pill = { contrib, updates: [], removed: false };
      pills.push(pill);
      return {
        update: (patch: { label?: string }) => {
          if (!pill.removed) pill.updates.push(patch);
        },
        remove: () => {
          pill.removed = true;
        },
      };
    },
    paseo: {
      agents: {
        async list(options: { signal?: AbortSignal }) {
          if (opts.holdList) await listGate;
          options?.signal?.addEventListener("abort", () => {
            aborted = true;
          });
          return {
            requestId: "r1",
            subscriptionId: "s1",
            subscription: {
              subscriptionId: "s1",
              ready: Promise.resolve({} as never),
              subscribe(observer: { snapshot(s: { entries: unknown[] }): void; update(m: unknown): void }) {
                observers.push(observer);
                return () => {
                  observers = observers.filter((o) => o !== observer);
                };
              },
              async release() {
                agentsReleased = true;
              },
            },
            entries: [],
            pageInfo: {},
          };
        },
        ref(id: string) {
          const t = timelineFor(id);
          return {
            timeline: {
              subscribe(handler: (e: { agentId: string; event: unknown }) => void) {
                t.handlers.push(handler);
                return {
                  ready: Promise.resolve(),
                  subscriptionId: `t-${id}`,
                  async release() {
                    t.released = true;
                  },
                };
              },
            },
          };
        },
      },
    },
  };
  const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return {
    client: fake as unknown as PlanPillClient,
    reads,
    pills,
    timelines,
    timelineFor,
    flush,
    releaseList: () => resolveList(),
    releaseRead: () => resolveRead(),
    observed: () => observers.length,
    snapshot: (agents: unknown[]) => {
      // directory entries carry { agent, project }, like FetchAgentsEntry
      const entries = agents.map((agent) => ({ agent, project: {} }));
      for (const o of [...observers]) o.snapshot({ entries });
    },
    update: (message: unknown) => {
      for (const o of [...observers]) o.update(message);
    },
    emit: (id: string, event: unknown) => {
      for (const h of [...timelineFor(id).handlers]) h({ agentId: id, event });
    },
    released: () => agentsReleased,
    aborted: () => aborted,
  };
}

const pillFor = (h: ReturnType<typeof harness>, agentId: string) => h.pills.find((p) => p.contrib.agentId === agentId);
const label = (p: Pill) => p.updates.at(-1)?.label ?? p.contrib.button.label;

const Content = (() => null) as never;

test("one pill per Claude agent; other providers, closed agents and workspace-less agents get none", async () => {
  const h = harness();
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1"), agent("a2", { provider: "opencode" }), agent("a3", { status: "closed" }), agent("a4", { workspaceId: undefined })]);
  await h.flush();
  assert.equal(h.pills.length, 1);
  assert.equal(pillFor(h, "a1")?.contrib.workspaceId, "w1");
  assert.equal(pillFor(h, "a1")?.contrib.button.behavior.kind, "popover");
  assert.equal(label(pillFor(h, "a1")!), "Plan");
});

test("labels bootstrap from the task files and update per agent, never across agents", async () => {
  const h = harness();
  h.timelineFor("a1").rows = [planRow(["completed", "pending", "pending"])];
  h.timelineFor("a2").rows = [planRow(["pending", "pending"])];
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1"), agent("a2")]);
  await h.flush();
  assert.equal(label(pillFor(h, "a1")!), "Plan 1/3");
  assert.equal(label(pillFor(h, "a2")!), "Plan 0/2");
  h.emit("a1", { type: "timeline", item: planRow(["completed", "completed", "pending"]) });
  h.emit("a1", { type: "timeline", item: { type: "tool_call", callId: "x", name: "Bash" } }); // not our row: no change
  assert.equal(label(pillFor(h, "a1")!), "Plan 2/3");
  assert.equal(label(pillFor(h, "a2")!), "Plan 0/2");
});

test("the files are read by the agent's Claude session id; an agent without one is not asked", async () => {
  const h = harness();
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1"), agent("a2", { persistence: null })]);
  await h.flush();
  assert.deepEqual(h.reads, ["s-a1"]);
  assert.equal(label(pillFor(h, "a2")!), "Plan");
});

test("a pill made before its agent had a session reads the files once the session id arrives", async () => {
  const h = harness();
  h.timelineFor("a1").rows = [planRow(["completed", "pending"])];
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1", { persistence: null })]);
  await h.flush();
  assert.equal(label(pillFor(h, "a1")!), "Plan");
  h.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1") } });
  await h.flush();
  assert.equal(label(pillFor(h, "a1")!), "Plan 1/2");
  assert.deepEqual(h.reads, ["s-a1"]);
});

test("a restored or replaced epoch rereads the task files", async () => {
  const h = harness();
  h.timelineFor("a1").rows = [planRow(["pending"])];
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1")]);
  await h.flush();
  assert.equal(label(pillFor(h, "a1")!), "Plan 0/1");
  h.timelineFor("a1").rows = [planRow(["completed"])];
  h.emit("a1", { type: "replacement", epoch: "e2" });
  await h.flush();
  assert.equal(label(pillFor(h, "a1")!), "Plan 1/1");
});

test("a list that resolves after cleanup registers nothing and releases its subscription", async () => {
  const h = harness({ holdList: true });
  const stop = registerPlanPills(h.client, Content);
  await h.flush();
  stop(); // unload while the list is still in flight
  h.releaseList();
  await h.flush();
  assert.equal(h.pills.length, 0);
  assert.equal(h.observed(), 0);
  assert.equal(h.released(), true);
});

test("a snapshot that omits an agent drops its pill", async () => {
  const h = harness();
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1"), agent("a2")]);
  await h.flush();
  h.snapshot([agent("a1")]); // full projection without a2: it is gone from the directory
  assert.equal(pillFor(h, "a2")?.removed, true);
  assert.equal(h.timelines.get("a2")?.released, true);
  assert.equal(pillFor(h, "a1")?.removed, false);
});

test("an agent that changed workspace re-registers its pill under the new workspace", async () => {
  const h = harness();
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1")]);
  await h.flush();
  h.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a1", { workspaceId: "w2" }) } });
  await h.flush();
  const a1 = h.pills.filter((p) => p.contrib.agentId === "a1");
  assert.equal(a1.length, 2); // the old one is gone, a new one lives under w2
  assert.equal(a1[0]!.removed, true);
  assert.equal(a1[1]!.removed, false);
  assert.equal(a1[1]!.contrib.workspaceId, "w2");
});

test("a slow bootstrap does not overwrite a newer live label", async () => {
  const h = harness({ holdRead: true });
  h.timelineFor("a1").rows = [planRow(["pending"])];
  registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1")]);
  await h.flush(); // the bootstrap's read is still in flight
  h.emit("a1", { type: "timeline", item: planRow(["completed"]) });
  const pill = pillFor(h, "a1")!;
  assert.deepEqual(pill.updates, [{ label: "Plan 1/1" }]);
  h.releaseRead();
  await h.flush();
  assert.deepEqual(pill.updates, [{ label: "Plan 1/1" }]); // the stale read was discarded, not applied
});

test("remove and cleanup isolate per agent and release every subscription", async () => {
  const h = harness();
  const stop = registerPlanPills(h.client, Content);
  await h.flush();
  h.snapshot([agent("a1"), agent("a2")]);
  await h.flush();
  assert.equal(h.pills.length, 2);

  h.update({ type: "agent_update", payload: { kind: "remove", agentId: "a1" } });
  assert.ok(h.pills.filter((p) => p.contrib.agentId === "a1").every((p) => p.removed));
  assert.equal(h.timelines.get("a1")?.released, true);
  assert.equal(pillFor(h, "a2")?.removed, false); // the other agent keeps its pill and its subscription
  assert.equal(h.timelines.get("a2")?.released, false);

  h.update({ type: "agent_update", payload: { kind: "upsert", agent: agent("a2", { provider: "opencode" }) } });
  assert.equal(pillFor(h, "a2")?.removed, true); // provider change away from claude drops it too

  stop();
  assert.equal(h.timelines.get("a2")?.released, true);
  assert.equal(h.released(), true);
  assert.equal(h.aborted(), true);
});
