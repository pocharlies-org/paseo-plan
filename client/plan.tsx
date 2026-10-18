import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PlanData } from "../shared/plan.ts";

const marker = { completed: "✓", in_progress: "◐", pending: "○", other: "·" } as const;
const mono = { fontFamily: "monospace", lineHeight: 18 } as const;

// Flat rows, no box: the same look as Paseo's own timeline rows.
export function Plan({ item, theme }: PluginTimelineItemProps<PlanData>) {
  const c = theme.colors;
  // Undefined = never touched: the task in progress is open, the rest closed.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  const rule = { borderLeftWidth: 1, borderLeftColor: c.border };
  return (
    <View style={{ marginVertical: 6 }}>
      {item.data.tasks.map((t) => {
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
