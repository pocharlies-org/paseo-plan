import type { PluginServerContext } from "@getpaseo/plugin/server";
import { KIND } from "./shared/plan.ts";
import { PlanState } from "./server/plan.ts";

const THROTTLE_MS = 300;

interface Live {
  release: () => Promise<void> | void;
  flush: () => Promise<void>;
}

export default function contribute(server: PluginServerContext) {
  const live = new Map<string, Live>();

  const stop = async (agentId: string) => {
    const l = live.get(agentId);
    if (!l) return;
    live.delete(agentId);
    await l.flush();
    await l.release();
  };

  server.on("agent.turn_started", async (event, { paseo }) => {
    if (!event.agent.provider.startsWith("claude") || live.has(event.agent.id)) return;
    const agent = paseo.agents.ref(event.agent.id);
    const state = new PlanState();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let dirty = false;

    const flush = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const data = dirty ? state.data() : null;
      dirty = false;
      if (data) await agent.timeline.append({ type: "plugin", id: "plan", kind: KIND, version: 1, data });
    };
    const schedule = () => {
      dirty = true;
      timer ??= setTimeout(() => void flush().catch((e) => console.error("plan append failed", e)), THROTTLE_MS);
    };

    const unsubscribe = agent.timeline.subscribe(({ event: e }) => {
      if (e.type === "timeline" && state.observe(e.item as never)) schedule();
    });
    live.set(event.agent.id, { release: () => unsubscribe.release(), flush });
    await unsubscribe.ready;
    const page = await agent.timeline.refetch({ direction: "before", limit: 200, projection: "projected" });
    for (const entry of page.entries) state.observe(entry.item as never);
  });

  server.on("agent.turn_ended", (event) => stop(event.agent.id));
  server.on("agent.closed", (event) => stop(event.agent.id));

  return () => {
    for (const id of [...live.keys()]) void stop(id);
  };
}
