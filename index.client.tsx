import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addPlanPill } from "./client/plan-pill.tsx";

export default function contribute(client: PluginClientContext) {
  return addPlanPill(client);
}
