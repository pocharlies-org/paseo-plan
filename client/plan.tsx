import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PlanData } from "../shared/plan.ts";

const marker = { completed: "✓", in_progress: "◐", pending: "○", other: "·" } as const;
const mono = { fontFamily: "monospace", fontSize: 12, lineHeight: 18 } as const;

export function Plan({ item, theme }: PluginTimelineItemProps<PlanData>) {
  const c = theme.colors;
  // Undefined = never touched: the task in progress is open, the rest closed.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState<Record<string, boolean>>({});
  return (
    <View style={{ gap: 4, borderWidth: 1, borderColor: c.border, borderRadius: 14, paddingVertical: 14, paddingHorizontal: 16, marginVertical: 8, backgroundColor: c.surface1 }}>
      {item.data.tasks.map((t) => {
        const color = t.status === "completed" ? c.statusSuccess : t.status === "in_progress" ? c.accent : c.foregroundMuted;
        const open = toggled[t.key] ?? t.status === "in_progress";
        const canOpen = t.commands.length > 0;
        const active = t.status === "in_progress";
        return (
          <View key={t.key}>
            <Pressable
              disabled={!canOpen}
              onPress={() => setToggled((s) => ({ ...s, [t.key]: !open }))}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 7 }}
            >
              <Text style={{ color, width: 16, textAlign: "center", fontSize: 15 }}>{marker[t.status]}</Text>
              <Text
                style={{
                  color: active ? c.foreground : c.foregroundMuted,
                  fontWeight: active ? "600" : "400",
                  fontSize: 14,
                  lineHeight: 20,
                  flex: 1,
                }}
              >
                {active ? (t.activeForm ?? t.text) : t.text}
              </Text>
              {canOpen ? (
                <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
                  {t.commands.length} {open ? "▾" : "▸"}
                </Text>
              ) : null}
            </Pressable>
            {open && canOpen ? (
              <ScrollView
                nestedScrollEnabled
                style={{ maxHeight: 260, marginLeft: 28, marginBottom: 8, backgroundColor: c.surface2, borderRadius: 10 }}
                contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 12, gap: 6 }}
              >
                {t.commands.map((cmd, i) => {
                  const id = `${t.key}:${i}`;
                  const failed = cmd.status === "failed";
                  return (
                    <View key={i} style={{ gap: 6 }}>
                      <Pressable disabled={!cmd.detail} onPress={() => setShown((s) => ({ ...s, [id]: !s[id] }))}>
                        <Text numberOfLines={1} style={{ ...mono, color: failed ? c.statusDanger : c.foreground }}>
                          <Text style={{ color: failed ? c.statusDanger : c.foregroundMuted }}>{cmd.status === "running" ? "▸ " : "· "}</Text>
                          {cmd.label}
                          {cmd.detail ? <Text style={{ color: c.foregroundMuted }}>{shown[id] ? "  ▾" : "  ▸"}</Text> : null}
                        </Text>
                      </Pressable>
                      {shown[id] && cmd.detail ? (
                        <Text selectable style={{ ...mono, fontSize: 11, color: c.foregroundMuted, backgroundColor: c.surface0, borderRadius: 8, padding: 10 }}>
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
