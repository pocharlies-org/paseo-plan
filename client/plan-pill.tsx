import type { PluginButtonContentProps, PluginClientContext } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { fold, planLabel, taskStatus, type Plan } from "../shared/plan.ts";

// One composer pill per running agent with its plan (Claude Desktop v2.42304.0 shows it as a box at the end of the
// conversation; plugins have no slot there, so it is a pill — Dani 17-10). Only running agents are followed: when a turn
// starts the tail of the timeline is read once and live rows keep it current; when the agent stops, the pill goes.
type Agent = { id: string; workspaceId?: string | null; status: string; archivedAt?: string | null };
type Pill = ReturnType<PluginClientContext["addComposerPill"]>;
type Tracked = { plan: Plan | null; pill?: Pill; stop(): void };

// shortcut: a plan older than the last 200 rows shows only from its next update; page back with direction "before" if it bites.
const TAIL = 200;
const ICON = { completed: "CircleCheck", in_progress: "CircleDot", pending: "CircleDashed" } as const;

function PlanCard({ plan, theme }: PluginButtonContentProps & { plan: Plan }) {
  const { foreground, foregroundMuted } = theme.colors;
  return (
    <View style={{ gap: 6 }}>
      {plan.stale ? <Text style={{ color: foregroundMuted, fontSize: 12 }}>Plan anterior a tu último mensaje</Text> : null}
      {plan.tasks.map((task, index) => {
        const status = taskStatus(task);
        return (
          <View key={task.id ?? index} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name={ICON[status]} size={14} color={status === "pending" ? foregroundMuted : foreground} />
            <Text
              style={{
                color: status === "completed" ? foregroundMuted : foreground,
                fontSize: 13,
                textDecorationLine: status === "completed" ? "line-through" : "none",
              }}
            >
              {task.text}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

export function addPlanPill(client: PluginClientContext): () => void {
  const tracked = new Map<string, Tracked>();
  let stopped = false;
  const lifetime = new AbortController();

  const untrack = (id: string) => {
    const entry = tracked.get(id);
    if (!entry) return;
    entry.stop();
    entry.pill?.remove();
    tracked.delete(id);
  };

  const render = (agent: Agent, entry: Tracked) => {
    if (stopped || tracked.get(agent.id) !== entry || !agent.workspaceId) return;
    const plan = entry.plan;
    const button = {
      title: "Plan",
      icon: "ListChecks",
      label: plan ? planLabel(plan) : "Plan",
      visible: plan !== null,
      behavior: {
        kind: "popover" as const,
        Content: (props: PluginButtonContentProps) => (plan ? <PlanCard {...props} plan={plan} /> : null),
      },
    };
    if (entry.pill) entry.pill.update(button);
    else entry.pill = client.addComposerPill({ id: "plan", workspaceId: agent.workspaceId, agentId: agent.id, button });
  };

  const track = (agent: Agent) => {
    const timeline = client.paseo.agents.ref(agent.id).timeline;
    const entry: Tracked = { plan: null, stop: () => {} };
    tracked.set(agent.id, entry);
    // Live rows that arrive while the tail is being read are replayed on top of it, so none is lost in between.
    let pending: Array<{ type: string }> | null = [];
    const load = async () => {
      pending = [];
      const page = await timeline.refetch({ direction: "tail", limit: TAIL });
      let plan = page.entries.reduce<Plan | null>((acc, row) => fold(acc, row.item), null);
      plan = pending.reduce(fold, plan);
      pending = null;
      entry.plan = plan;
      render(agent, entry);
    };
    const reload = () =>
      void load().catch((error) => {
        if (!stopped && tracked.get(agent.id) === entry) console.error("plan: timeline read failed", error);
      });
    const subscription = timeline.subscribe(({ event }) => {
      if (event.type === "timeline") {
        if (pending) pending.push(event.item);
        else {
          entry.plan = fold(entry.plan, event.item);
          render(agent, entry);
        }
      } else if (event.type === "replacement" || event.type === "subscription_restored") reload();
    });
    entry.stop = subscription;
    void subscription.ready.then(reload, () => {});
  };

  const show = (agent: Agent) => {
    if (stopped) return;
    if (agent.status !== "running" || !agent.workspaceId || agent.archivedAt) return untrack(agent.id);
    if (!tracked.has(agent.id)) track(agent);
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const id of [...tracked.keys()]) untrack(id);
          for (const { agent } of entries) show(agent as Agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") untrack(update.agentId);
          else show(update.agent as Agent);
        },
      });
    })
    .catch((error) => {
      if (!stopped) console.error("plan: agent observation failed", error);
    });

  return () => {
    stopped = true;
    lifetime.abort();
    for (const id of [...tracked.keys()]) untrack(id);
  };
}
