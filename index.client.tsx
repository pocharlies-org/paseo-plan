import type { PluginClientContext } from "@getpaseo/plugin/client";
import { PANEL_ID, Plan, PlanPanel, planPopover } from "./client/plan";
import { registerPlanPills } from "./client/pills";
import { KIND, ownCardElsewhere, planSchema } from "./shared/plan";

// The card holds the task list and every command, so Paseo's own task rows and tool-call rows go — except a call another
// plugin draws as its own card, which is left for that plugin. The server only feeds Claude agents: a provider with no card
// would lose its tool calls here. The same list is reachable from the composer through a per-agent pill (SC-4614), so it
// is not buried in the timeline, and as a panel of the right sidebar (SC-4798); both start from Claude Code's task files
// (plan.get) and then follow the row the server appends, never a second fold.
export default function contribute(client: PluginClientContext) {
  client.addTimelineRenderer({ kind: KIND, version: 1, schema: planSchema, Component: Plan });
  const drop = { items: [] };
  client.addTimelineTransformer({ id: "plan-todo", query: { itemType: "todo" }, transform: () => drop });
  client.addTimelineTransformer({
    id: "plan-tool-calls",
    query: { itemType: "tool_call" },
    transform: ({ item }) => (ownCardElsewhere(item.name) ? undefined : drop),
  });
  const stopPills = registerPlanPills(client, planPopover((id, options) => client.openPanel(id, options)));
  // The same list as a panel of the right-hand sidebar (Explorer), per agent (SC-4798), opened from the popover.
  const stopPanel = client.addWorkspacePanel({ id: PANEL_ID, title: "Plan", icon: "ListChecks", context: "agent", locations: ["explorer"], Component: PlanPanel });
  return () => {
    stopPills();
    stopPanel();
  };
}
