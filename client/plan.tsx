import type { PluginAgentPanelProps, PluginButtonContentProps, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { planFromTimelineItem, planGet, type PlanData } from "../shared/plan.ts";

const marker = { completed: "✓", in_progress: "◐", pending: "○", other: "·" } as const;
const mono = { fontFamily: "monospace", lineHeight: 18 } as const;

// Flat rows, no box: the same look as Paseo's own timeline rows. Shared by the timeline card and the composer popover.
function PlanView({ data, theme }: { data: PlanData; theme: PluginTimelineItemProps["theme"] }) {
  const c = theme.colors;
  // Undefined = never touched: the task in progress is open, the rest closed.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const rule = { borderLeftWidth: 1, borderLeftColor: c.border };
  return (
    <View style={{ marginVertical: 6 }}>
      {data.tasks.map((t) => {
        const color = t.status === "completed" ? c.statusSuccess : t.status === "in_progress" ? c.accent : c.foregroundMuted;
        const active = t.status === "in_progress";
        const open = toggled[t.key] ?? active;
        const canOpen = t.commands.length > 0;
        const n = t.commands.length;
        const title = t.status === "other" ? `Ejecutó ${n} ${n === 1 ? "comando" : "comandos"}` : active ? (t.activeForm ?? t.text) : t.text;
        return (
          <View key={t.key}>
            <Pressable
              disabled={!canOpen}
              onPress={() => setToggled((s) => ({ ...s, [t.key]: !open }))}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}
            >
              <Text style={{ color, width: 18, textAlign: "center", fontSize: 15 }}>{marker[t.status]}</Text>
              <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontWeight: active ? "600" : "400", fontSize: 14, lineHeight: 20, flex: 1 }}>
                {title}
              </Text>
              {canOpen ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  {t.status === "other" ? "" : `${n} `}
                  {open ? "▾" : "▸"}
                </Text>
              ) : null}
            </Pressable>
            {open && canOpen ? (
              <ScrollView
                nestedScrollEnabled
                style={{ maxHeight: 260, marginLeft: 8, marginBottom: 4 }}
                contentContainerStyle={{ ...rule, paddingLeft: 20, paddingVertical: 2, gap: 6 }}
              >
                {t.commands.map((cmd, i) => {
                  const id = `${t.key}:${i}`;
                  const failed = cmd.status === "failed";
                  return (
                    <View key={i} style={{ gap: 4 }}>
                      <Pressable disabled={!cmd.detail} onPress={() => setShown((s) => ({ ...s, [id]: !s[id] }))}>
                        <Text numberOfLines={1} style={{ ...mono, fontSize: 12, color: failed ? c.statusDanger : c.foregroundMuted }}>
                          {cmd.status === "running" ? "▸ " : ""}
                          {cmd.label}
                          {cmd.detail ? `  ${shown[id] ? "▾" : "▸"}` : ""}
                        </Text>
                      </Pressable>
                      {shown[id] && cmd.detail ? (
                        <Text selectable style={{ ...mono, ...rule, fontSize: 11, color: c.foregroundMuted, paddingLeft: 10, marginBottom: 2 }}>
                          {cmd.detail}
                        </Text>
                      ) : null}
                    </View>
                  );
                })}
              </ScrollView>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

export function Plan({ item, theme }: PluginTimelineItemProps<PlanData>) {
  return <PlanView data={item.data} theme={theme} />;
}

// The same list at the composer and in the side panel: bootstrap from the task files on the daemon host (plan.get, so a
// long session or a reload still finds it) and follow live events; a replaced epoch or a restored subscription
// rereads, since live events alone no longer tell all.
function LivePlan({ agentId, theme }: { agentId: string | undefined; theme: PluginTimelineItemProps["theme"] }) {
  const paseo = usePaseo();
  const getPlan = useRpc(planGet);
  const [data, setData] = useState<PlanData | null>(null);
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    // same race as the pill's label: files read while live rows were landing are older than what is on screen
    let tick = 0;
    let boot = 0;
    const handle = paseo.agents.ref(agentId);
    const apply = (item: unknown) => {
      const d = planFromTimelineItem(item);
      if (d && alive) {
        tick++;
        setData(d);
      }
    };
    const bootstrap = async () => {
      const id = ++boot;
      const seen = tick;
      const plan = await getPlan({ agentId }).then((r) => r.plan, () => null);
      if (plan && alive && id === boot && tick === seen) setData(plan); // else superseded by a newer read or a live row
    };
    const sub = handle.timeline.subscribe((e) => {
      if (e.event.type === "timeline") apply(e.event.item);
      else if (e.event.type === "replacement" || e.event.type === "subscription_restored") void bootstrap();
    });
    sub.ready.catch(() => {}); // establishment failure leaves the list on the bootstrapped plan
    void bootstrap();
    return () => {
      alive = false;
      void sub.release().catch(() => {});
    };
  }, [paseo, getPlan, agentId]);
  if (!data) {
    return (
      <View style={{ padding: 12 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Sin plan todavía.</Text>
      </View>
    );
  }
  return <PlanView data={data} theme={theme} />;
}

export function PlanPopover({ theme, ...props }: PluginButtonContentProps) {
  // A composer pill is always registered in agent context; the type allows the workspace variant too.
  const agentId = props.context === "agent" ? props.agentId : undefined;
  return (
    <View style={{ paddingHorizontal: 10, paddingVertical: 4, minWidth: 280, maxWidth: 420 }}>
      <LivePlan agentId={agentId} theme={theme} />
    </View>
  );
}

export function PlanPanel({ agentId, theme }: PluginAgentPanelProps) {
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <LivePlan agentId={agentId} theme={theme} />
    </ScrollView>
  );
}
