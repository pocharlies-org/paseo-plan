import type { PluginHookAgent, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import { anchorGet, anchorGuard, anchorRow } from "./shared/anchor.ts";
import { KIND, planGet, type PlanData } from "./shared/plan.ts";
import { buildPlan, readAnchor, saveAnchor, setGuard } from "./server/anchor.ts";
import { PlanState } from "./server/plan.ts";
import { planFromTasks } from "./server/tasks.ts";

const THROTTLE_MS = 300;

interface Live {
  release: () => Promise<void> | void;
  flush: () => Promise<void>;
}

export default function contribute(server: PluginServerContext) {
  const live = new Map<string, Live>();

  server.handle(planGet, async ({ sessionIds }) => ({
    plans: Object.fromEntries(await Promise.all(sessionIds.map(async (id) => [id, await planFromTasks(id)] as const))),
  }));

  server.handle(anchorGet, ({ agentId }) => ({ anchor: readAnchor(agentId) }));
  server.handle(anchorGuard, async ({ agentId, guard }, { paseo }) => {
    const anchor = setGuard(agentId, guard);
    if (anchor) await paseo.agents.ref(agentId).timeline.append(anchorRow(anchor)).catch(() => {}); // a closed agent has no timeline: the file is what counts
    return { anchor };
  });

  // The plan anchor (SC-4804), rebuilt at every turn start and end so an edited spec re-anchors; Jira not answering keeps the old one.
  const anchor = async (agent: PluginHookAgent, paseo: PluginHookContext["paseo"]) => {
    const handle = paseo.agents.ref(agent.id);
    const sessionId = await handle.refresh().then(() => {
      const current = handle.current();
      return current?.persistence?.sessionId ?? current?.runtimeInfo?.sessionId ?? null;
    }, () => null);
    const plan = await buildPlan(agent.cwd, sessionId);
    if (plan) await handle.timeline.append(anchorRow(saveAnchor(agent.id, plan)));
  };
  const refreshAnchor = (agent: PluginHookAgent, paseo: PluginHookContext["paseo"]) => {
    if (agent.provider.startsWith("claude")) void anchor(agent, paseo).catch((e) => console.error("plan anchor failed", e));
  };

  const stop = async (agentId: string) => {
    const l = live.get(agentId);
    if (!l) return;
    live.delete(agentId);
    await l.flush();
    // A turn that ends before the subscription handshake releases it unestablished: that rejection is expected.
    try {
      await l.release();
    } catch (e) {
      if (!/Subscription released/.test(String((e as Error).message))) throw e;
    }
  };

  server.on("agent.turn_started", async (event, { paseo }) => {
    refreshAnchor(event.agent, paseo);
    if (!event.agent.provider.startsWith("claude") || live.has(event.agent.id)) return;
    const agent = paseo.agents.ref(event.agent.id);
    const state = new PlanState();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;
    let sessionId: string | null = null;

    // The live list knows no plans: each task takes its plan from the task files, so the pill counts the latest plan.
    const placeInPlans = async (data: PlanData) => {
      sessionId ||= await agent.refresh().then(() => {
        const current = agent.current();
        return current?.persistence?.sessionId ?? current?.runtimeInfo?.sessionId ?? null;
      }, () => null);
      const files = sessionId ? await planFromTasks(sessionId) : null;
      const plans = new Map(files?.tasks.map((t) => [t.key, t.plan]));
      for (const t of data.tasks) t.plan = plans.get(t.key);
    };

    let queue: Promise<void> = Promise.resolve();

    // One append at a time: placing the tasks reads the files, and an older list must not land after a newer one.
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const data = dirty ? state.data() : null;
      dirty = false;
      const run = queue.then(async () => {
        if (!data) return;
        await placeInPlans(data);
        // placement "tail" keeps the plan the last row so streaming text appears above it (SC-2758). The old host
        // strips the field; the variable dodges the excess-property check of the pinned 0.11.2 types. shortcut: <0.11.2 types>, <bump @getpaseo/client when placement ships>
        const item = { type: "plugin" as const, id: "plan", kind: KIND, version: 1, data, placement: "tail" as const };
        await agent.timeline.append(item);
      });
      queue = run.catch(() => {});
      return run;
    };
    const schedule = () => {
      dirty = true;
      timer ??= setTimeout(() => void flush().catch((e) => console.error("plan append failed", e)), THROTTLE_MS);
    };

    const unsubscribe = agent.timeline.subscribe(({ event: e }) => {
      if (e.type === "timeline" && state.observe(e.item as never)) schedule();
    });
    const entry: Live = { release: () => unsubscribe.release(), flush };
    live.set(event.agent.id, entry);
    try {
      await unsubscribe.ready;
    } catch (e) {
      if (live.get(event.agent.id) !== entry) return; // the turn ended first and released it: nothing to seed
      await stop(event.agent.id);
      throw e;
    }
    const page = await agent.timeline.refetch({ direction: "before", limit: 200, projection: "projected" });
    for (const row of page.entries) state.observe(row.item as never);
  });

  server.on("agent.turn_ended", (event, { paseo }) => {
    refreshAnchor(event.agent, paseo);
    return stop(event.agent.id);
  });
  server.on("agent.closed", (event) => stop(event.agent.id));

  return () => {
    for (const id of [...live.keys()]) void stop(id);
  };
}
