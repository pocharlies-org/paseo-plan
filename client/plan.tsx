import type { PluginAgentPanelProps, PluginButtonContentProps, PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { knownSessions } from "./pills.ts";
import { keepCommands, planFromTimelineItem, planGet, type PlanData } from "../shared/plan.ts";

const marker = { completed: "✓", in_progress: "◐", pending: "○", other: "·" } as const;
const mono = { fontFamily: "monospace", lineHeight: 18 } as const;

// Flat rows, no box: the same look as Paseo's own timeline rows. Shared by the timeline card, the popover and the panel.
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
  // undefined while the first read is in flight: "no plan" only once the files said so
  const [data, setData] = useState<PlanData | null | undefined>(undefined);
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
    // the session id the pill already knows, else the agent's snapshot: one refresh per open popover or panel
    const known = knownSessions.get(agentId);
    const session = known ? Promise.resolve(known) : handle.refresh().then(() => {
      const current = handle.current();
      return current?.persistence?.sessionId ?? current?.runtimeInfo?.sessionId ?? null;
    }, () => null);
    const bootstrap = async () => {
      const id = ++boot;
      const seen = tick;
      const sessionId = await session;
      const plan = sessionId ? await getPlan({ sessionIds: [sessionId] }).then((r) => r.plans[sessionId] ?? null, () => null) : null;
      if (!alive || id !== boot) return; // superseded by a newer read
      // a live row that landed while reading is newer than the files
      setData((shown) => (plan && tick === seen ? keepCommands(plan, shown ?? null) : (shown ?? null)));
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
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
          {data === undefined ? "Cargando el plan…" : "Sin plan todavía."}
        </Text>
      </View>
    );
  }
  return <PlanView data={data} theme={theme} />;
}

// The host lists agent panels in no menu (0.15.1): the popover is the way into the side panel.
export const PANEL_ID = "plan";
type OpenPanel = PluginClientContext["openPanel"];

export const planPopover = (openPanel: OpenPanel) =>
  function PlanPopover({ theme, close, ...props }: PluginButtonContentProps) {
    // A composer pill is always registered in agent context; the type allows the workspace variant too.
    const agentId = props.context === "agent" ? props.agentId : undefined;
    return (
      <View style={{ paddingHorizontal: 10, paddingVertical: 4, minWidth: 280, maxWidth: 420 }}>
        {agentId ? (
          <Pressable
            onPress={() => {
              openPanel(PANEL_ID, { workspaceId: props.workspaceId, agentId, location: "explorer" });
              close();
            }}
            style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.colors.border }}
          >
            <Text style={{ color: theme.colors.accent, fontSize: 13 }}>Ver en la barra lateral</Text>
          </Pressable>
        ) : null}
        <LivePlan agentId={agentId} theme={theme} />
      </View>
    );
  };

export function PlanPanel(props: PluginAgentPanelProps) {
  // 0.15 hands the agent in params and keeps agentId as deprecated; 0.11 only has agentId.
  const agentId = (props as { params?: { agentId?: string } }).params?.agentId ?? props.agentId;
  const { theme } = props;
  return (
    <ScrollView contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4 }}>
      <LivePlan agentId={agentId} theme={theme} />
    </ScrollView>
  );
}
