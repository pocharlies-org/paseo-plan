import type { PluginAgentPanelProps, PluginButtonContentProps, PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { openExternalUrl, usePaseo, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { knownSessions } from "./pills.ts";
import { anchorFromTimelineItem, anchorGet, anchorGuard, type Anchor } from "../shared/anchor.ts";
import { keepCommands, lastFailedCommand, planFromTimelineItem, planGet, splitPlans, taskState, type PlanData, type PlanTask } from "../shared/plan.ts";

// The marker and color come from taskState, the state read from explicit data only (SC-5089): a pending task with an
// unmet blockedBy is blocked (⏸, warning), never guessed from its text.
const stateMark = { completed: "✓", running: "◐", blocked: "⏸", waiting: "○", other: "·" } as const;
const mono = { fontFamily: "monospace", lineHeight: 18 } as const;

// Flat rows, no box: the same look as Paseo's own timeline rows. Shared by the timeline card, the popover and the panel.
// Completed commands fold by default (SC-5089): what stays open is the command running now and the last failed one —
// the error that matters — and each command's detail still expands on tap.
function PlanView({ data, theme }: { data: PlanData; theme: PluginTimelineItemProps["theme"] }) {
  const c = theme.colors;
  // Undefined = never touched: the task in progress and any task with a failed command open, the rest closed.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const rule = { borderLeftWidth: 1, borderLeftColor: c.border };
  return (
    <View style={{ marginVertical: 6 }}>
      {data.tasks.map((t) => {
        const st = taskState(t, data.tasks);
        const color = st === "completed" ? c.statusSuccess : st === "running" ? c.accent : st === "blocked" ? c.statusWarning : c.foregroundMuted;
        const active = st === "running";
        // The running commands and the last error stay visible; the finished ones wait behind one line. A task with a
        // failed command opens by default even when it is not the active one: its last error must not hide behind a
        // closed task (SC-5089). Each command keeps its original index as its key and its shown id.
        const lastError = lastFailedCommand(t.commands);
        const open = toggled[t.key] ?? (active || lastError !== undefined);
        const canOpen = t.commands.length > 0;
        const n = t.commands.length;
        const title = t.status === "other" ? `Ejecutó ${n} ${n === 1 ? "comando" : "comandos"}` : active ? (t.activeForm ?? t.text) : t.text;
        const always = new Set(t.commands.filter((cmd) => cmd.status === "running" || cmd === lastError));
        const folded = t.commands.filter((cmd) => !always.has(cmd));
        const foldOpen = toggled[`${t.key}:fold`] ?? false;
        const failedCount = t.commands.filter((cmd) => cmd.status === "failed").length;
        const cmdRow = (cmd: PlanTask["commands"][number], i: number) => {
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
        };
        return (
          <View key={t.key}>
            <Pressable
              disabled={!canOpen}
              onPress={() => setToggled((s) => ({ ...s, [t.key]: !open }))}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}
            >
              <Text style={{ color, width: 18, textAlign: "center", fontSize: 15 }}>{stateMark[st]}</Text>
              <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontWeight: active ? "600" : "400", fontSize: 14, lineHeight: 20, flex: 1 }}>
                {title}
              </Text>
              {st === "blocked" ? <Text style={{ color: c.statusWarning, fontSize: 12 }}>bloqueado</Text> : null}
              {!open && failedCount ? (
                <Text style={{ color: c.statusDanger, fontSize: 12 }}>{failedCount === 1 ? "1 fallo" : `${failedCount} fallos`}</Text>
              ) : null}
              {canOpen ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  {t.status === "other" ? "" : `${n} `}
                  {open ? "▾" : "▸"}
                </Text>
              ) : null}
            </Pressable>
            {t.links?.length ? (
              <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginLeft: 28, marginBottom: 2 }}>
                {t.links.map((l) =>
                  l.kind === "file" ? (
                    // A file result is a path on the daemon host, not a URL: shown, selectable, never opened here.
                    <Text key={l.href} selectable style={{ ...mono, fontSize: 11, color: c.foregroundMuted }}>{l.label}</Text>
                  ) : (
                    <Pressable key={l.href} onPress={() => void openExternalUrl(l.href).catch(() => {})}>
                      <Text style={{ fontSize: 12, color: c.accent }}>{`${l.label} ↗`}</Text>
                    </Pressable>
                  ),
                )}
              </View>
            ) : null}
            {open && canOpen ? (
              <ScrollView
                nestedScrollEnabled
                style={{ maxHeight: 260, marginLeft: 8, marginBottom: 4 }}
                contentContainerStyle={{ ...rule, paddingLeft: 20, paddingVertical: 2, gap: 6 }}
              >
                {t.commands.map((cmd, i) => (always.has(cmd) ? cmdRow(cmd, i) : null))}
                {folded.length ? (
                  <View>
                    <Pressable onPress={() => setToggled((s) => ({ ...s, [`${t.key}:fold`]: !foldOpen }))}>
                      <Text style={{ ...mono, fontSize: 12, color: c.foregroundMuted }}>
                        {`${folded.length} ${folded.length === 1 ? "completado" : "completados"} ${foldOpen ? "▾" : "▸"}`}
                      </Text>
                    </Pressable>
                    {foldOpen ? folded.map((cmd) => cmdRow(cmd, t.commands.indexOf(cmd))) : null}
                  </View>
                ) : null}
              </ScrollView>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// The conversation card shows the latest plan only: the earlier ones are in the popover and the panel (SC-5050).
export function Plan({ item, theme }: PluginTimelineItemProps<PlanData>) {
  return <PlanView data={splitPlans(item.data).current} theme={theme} />;
}

// An earlier plan, folded to one line with its progress until tapped.
function EarlierPlan({ n, tasks, theme }: { n: number; tasks: PlanData["tasks"]; theme: PluginTimelineItemProps["theme"] }) {
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const done = tasks.filter((t) => t.status === "completed").length;
  return (
    <View style={{ borderBottomWidth: 1, borderBottomColor: c.border }}>
      <Pressable onPress={() => setOpen(!open)} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 13, flex: 1 }}>{`Plan ${n} · ${done}/${tasks.length}`}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? <PlanView data={{ tasks }} theme={theme} /> : null}
    </View>
  );
}

// The earlier plans folded on top, oldest first, then the latest one open.
function PlanHistory({ data, theme }: { data: PlanData; theme: PluginTimelineItemProps["theme"] }) {
  const { current, earlier } = splitPlans(data);
  return (
    <View>
      {earlier.map((tasks, i) => (
        <EarlierPlan key={tasks[0].key} n={i + 1} tasks={tasks} theme={theme} />
      ))}
      {earlier.length ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, paddingTop: 8 }}>{`Plan ${earlier.length + 1} · actual`}</Text>
      ) : null}
      <PlanView data={current} theme={theme} />
    </View>
  );
}

// The ticket's plan above the tasks (SC-4804): each criterion with its state and evidence, and «Garantizar plan».
// The ticket title links to its browse URL when the server row carries one (SC-5089): the key comes from the anchor,
// the URL from the Jira site the anchor's own reader uses — never invented here.
function AnchorView({ agentId, anchor, ticketUrl, onChange, theme }: { agentId: string; anchor: Anchor | null | undefined; ticketUrl?: string; onChange: (a: Anchor | null) => void; theme: PluginTimelineItemProps["theme"] }) {
  const c = theme.colors;
  const setGuard = useRpc(anchorGuard);
  const [busy, setBusy] = useState(false);
  if (anchor === undefined) return null;
  if (!anchor) return <Text style={{ color: c.foregroundMuted, fontSize: 13, paddingVertical: 8 }}>Sin plan</Text>;
  const disabled = busy || !anchor.criterios.length;
  const head = anchor.ticketKey ? `Plan de ${anchor.ticketKey}` : "Plan";
  return (
    <View style={{ paddingVertical: 6, gap: 4, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {ticketUrl && anchor.ticketKey ? (
        <Pressable onPress={() => void openExternalUrl(ticketUrl).catch(() => {})}>
          <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{`${head} ↗`}</Text>
        </Pressable>
      ) : (
        <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" }}>{head}</Text>
      )}
      {anchor.objetivo ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{anchor.objetivo}</Text> : null}
      {anchor.criterios.length ? null : <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>Sin criterios</Text>}
      {anchor.criterios.map((k, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 10, paddingVertical: 3 }}>
          <Text style={{ color: k.status === "verificada" ? c.statusSuccess : c.foregroundMuted, width: 18, textAlign: "center", fontSize: 15 }}>
            {k.status === "verificada" ? "✓" : "○"}
          </Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 18 }}>{`C${i + 1} · ${k.texto}`}</Text>
            {k.evidencia ? <Text style={{ ...mono, color: c.foregroundMuted, fontSize: 11 }}>{k.evidencia}</Text> : null}
          </View>
        </View>
      ))}
      <Pressable
        disabled={disabled}
        onPress={() => {
          setBusy(true);
          void setGuard({ agentId, guard: !anchor.guard }).then((r) => onChange(r.anchor), () => {}).finally(() => setBusy(false));
        }}
        style={{ paddingVertical: 8, opacity: disabled ? 0.5 : 1 }}
      >
        <Text style={{ color: anchor.guard ? c.statusSuccess : c.accent, fontSize: 13 }}>
          {anchor.guard ? "✓ Garantizar plan · encendido" : "Garantizar plan"}
        </Text>
      </Pressable>
    </View>
  );
}

// The same list at the composer and in the side panel: bootstrap from the task files on the daemon host (plan.get, so a
// long session or a reload still finds it) and follow live events; a replaced epoch or a restored subscription
// rereads, since live events alone no longer tell all.
function LivePlan({ agentId, theme }: { agentId: string | undefined; theme: PluginTimelineItemProps["theme"] }) {
  const paseo = usePaseo();
  const getPlan = useRpc(planGet);
  const getAnchor = useRpc(anchorGet);
  // undefined while reading, null = no anchor («Sin plan»)
  const [anchor, setAnchor] = useState<Anchor | null | undefined>(undefined);
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
      const a = anchorFromTimelineItem(item);
      if (a && alive) setAnchor(a);
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
    void getAnchor({ agentId }).then((r) => alive && setAnchor((shown) => shown ?? r.anchor), () => alive && setAnchor((shown) => shown ?? null));
    return () => {
      alive = false;
      void sub.release().catch(() => {});
    };
  }, [paseo, getPlan, getAnchor, agentId]);
  return (
    <View>
      {agentId ? <AnchorView agentId={agentId} anchor={anchor} ticketUrl={data?.ticket?.url} onChange={setAnchor} theme={theme} /> : null}
      {data ? (
        <PlanHistory data={data} theme={theme} />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 12 }}>
          {data === undefined ? "Cargando las tareas…" : "Sin tareas todavía."}
        </Text>
      )}
    </View>
  );
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
