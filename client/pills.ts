import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginComposerPillContribution,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { planFromTimelineItem, planGet, planProgressLabel, type PlanData } from "../shared/plan.ts";

// The slice of the host this module uses, typed against the real API: index.client.tsx hands in the plugin context,
// the tests hand in a fake. Keeping it free of React makes the per-agent lifecycle testable with node --test.
export interface PlanPillClient {
  addComposerPill(contribution: PluginComposerPillContribution): PluginButtonRegistration;
  rpc: PluginClientContext["rpc"];
  paseo: Pick<PluginClientContext["paseo"], "agents">;
}

type PaseoAgent = Awaited<ReturnType<PluginClientContext["paseo"]["agents"]["list"]>>["entries"][number]["agent"];

const PILL_ID = "plan";
const PILL_TITLE = "Plan de Claude";

// Same provider gate as the server half: without the plan rows there is nothing for the pill to show.
const isClaude = (agent: PaseoAgent) => agent.provider.startsWith("claude");

interface Live {
  reg: PluginButtonRegistration;
  workspaceId: string;
  release: () => Promise<void>;
  // live plan rows applied: a bootstrap whose refetch races one is stale and must not overwrite the label
  tick: number;
}

/**
 * One composer pill per Claude agent, opening the plan in a popover. Pills follow the agent directory (bootstrap
 * from the list snapshot, then upsert/remove deltas); each one bootstraps its label from the task files on the daemon
 * host (plan.get) and keeps it current through the typed timeline subscription. The returned cleanup detaches
 * everything, including a list that resolves late, after the plugin was already unloaded.
 */
export function registerPlanPills(client: PlanPillClient, Content: ComponentType<PluginButtonContentProps>): () => void {
  const live = new Map<string, Live>();
  const lifetime = new AbortController();
  let stopped = false;
  let stopAgents: (() => void) | undefined;
  let agentsSub: { release(): Promise<void> } | undefined;

  const apply = (agentId: string, item: unknown) => {
    const data = planFromTimelineItem(item);
    if (!data) return;
    const entry = live.get(agentId);
    if (!entry) return;
    entry.tick++;
    entry.reg.update({ label: planProgressLabel(data) });
  };

  const drop = (agentId: string) => {
    const l = live.get(agentId);
    if (!l) return;
    live.delete(agentId);
    l.reg.remove();
    // Releasing a subscription that never established rejects: expected, the pill is gone either way.
    void l.release().catch(() => {});
  };

  const upsert = (agent: PaseoAgent) => {
    if (stopped || !isClaude(agent) || agent.status === "closed" || !agent.workspaceId) return drop(agent.id);
    const existing = live.get(agent.id);
    if (existing) {
      if (existing.workspaceId === agent.workspaceId) return;
      drop(agent.id); // moved to another workspace: the pill is registered under the old id and must be re-made
    }
    const reg = client.addComposerPill({
      id: PILL_ID,
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: { title: PILL_TITLE, icon: "ListChecks", label: "Plan", behavior: { kind: "popover", Content } },
    });
    const handle = client.paseo.agents.ref(agent.id);
    const entry: Live = { reg, workspaceId: agent.workspaceId, release: () => Promise.resolve(), tick: 0 };
    const sub = handle.timeline.subscribe((e) => {
      if (live.get(agent.id) !== entry) return; // dropped while an event was in flight
      if (e.event.type === "timeline") apply(agent.id, e.event.item);
      // A new epoch or a restored subscription: live events alone no longer tell the whole story, reread.
      else if (e.event.type === "replacement" || e.event.type === "subscription_restored") void bootstrap();
    });
    sub.ready.catch(() => {}); // establishment failure leaves the pill on the bootstrapped label
    entry.release = () => sub.release();
    live.set(agent.id, entry);
    async function bootstrap() {
      const tick = entry.tick;
      const plan = await client.rpc(planGet, { agentId: agent.id }).then((r) => r.plan, (): PlanData | null => null);
      // dropped, re-registered, or a live row landed while reading: the files are older than what the pill shows
      if (!plan || live.get(agent.id) !== entry || entry.tick !== tick) return;
      entry.reg.update({ label: planProgressLabel(plan) });
    }
    void bootstrap();
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(
      (result) => {
        if (stopped) {
          void result.subscription.release().catch(() => {}); // the list resolved after unload: revive nothing
          return;
        }
        agentsSub = result.subscription;
        for (const entry of result.entries) upsert(entry.agent);
        stopAgents = result.subscription.subscribe({
          snapshot: ({ entries }) => {
            const present = new Set(entries.map((entry) => entry.agent.id));
            for (const entry of entries) upsert(entry.agent);
            // a full projection: anything not in it is gone from the directory
            for (const agentId of [...live.keys()]) if (!present.has(agentId)) drop(agentId);
          },
          update: (message) => {
            if (message.type !== "agent_update") return;
            if (message.payload.kind === "upsert") upsert(message.payload.agent);
            else drop(message.payload.agentId);
          },
        });
      },
      () => {}, // a list that never resolved (host down) registered nothing: nothing to clean either
    );

  return () => {
    stopped = true;
    lifetime.abort();
    stopAgents?.();
    void agentsSub?.release().catch(() => {});
    for (const agentId of [...live.keys()]) drop(agentId);
  };
}
