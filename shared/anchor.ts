import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const ANCHOR_KIND = "plan-anchor";

// The plan anchor of one agent: the ticket's criteria, with the guard of «Garantizar plan». The server writes it to
// ~/.local/state/paseo-plan/anchor-<agentId>.json, a file contract (CONTRACTS.yaml: file.paseo-plan.anchor.v1) that
// paseo-sugiere and the Stop hook read, and appends it as a plugin row for the pill.
export const anchorSchema = z.object({
  ticketKey: z.string().nullable(),
  objetivo: z.string(),
  criterios: z.array(z.object({ texto: z.string(), como_se_verifica: z.string(), status: z.string(), evidencia: z.string() })),
  fuera_de_alcance: z.array(z.string()),
  guard: z.boolean(),
});

export type Anchor = z.output<typeof anchorSchema>;

// A Paseo agent id: it names a file, so nothing else gets through.
const agentId = z.string().regex(/^[\w-]{1,128}$/);

export const anchorGet = defineRpc({
  name: "anchor.get",
  input: z.object({ agentId }).strict(),
  output: z.object({ anchor: anchorSchema.nullable() }),
});

// «Garantizar plan»: switches the guard in the agent's anchor file; with no criteria it stays off (Dani's decision 2).
export const anchorGuard = defineRpc({
  name: "anchor.guard",
  input: z.object({ agentId, guard: z.boolean() }).strict(),
  output: z.object({ anchor: anchorSchema.nullable() }),
});

export const anchorRow = (anchor: Anchor) => ({ type: "plugin" as const, id: ANCHOR_KIND, kind: ANCHOR_KIND, version: 1, data: anchor });

export const anchorFromTimelineItem = (item: unknown): Anchor | null => {
  const i = item as { type?: unknown; kind?: unknown; data?: unknown } | null;
  if (!i || i.type !== "plugin" || i.kind !== ANCHOR_KIND) return null;
  const parsed = anchorSchema.safeParse(i.data);
  return parsed.success ? parsed.data : null;
};
