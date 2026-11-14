# paseo-plan

A Paseo plugin that shows Claude's task list at the end of the conversation, like Claude Desktop's plan box, with
what each task actually did: tap a task to open the commands it ran, tap a command to see its output.

- The task in progress is open by default and shows the live commands, and so is any task with a failed command —
  active or not — so its last error is never hidden; the rest stay closed. Completed commands fold under one line
  (`N completados ▸`); what stays visible is the command running now and the last failed one, and a closed task with
  failures says so (`2 fallos`). Each command keeps its original index as its key and its detail-expansion id, and
  its output still expands on tap.
- The same list opens from a `Plan` pill next to the composer (per Claude agent): its text is the progress `x/y` plus
  the task in progress, cut short to fit the composer; the button's title carries the same sentence in full for the
  accessible read. The popover shows the full list without scrolling the conversation.
- States come from explicit data only (SC-5089): running, waiting and done from the task status, and **blocked** — `⏸`,
  in warning color, with the word «bloqueado» — only when Claude Code's task file lists a `blockedBy` whose blockers
  are not done. A task is never shown as blocked, and a command never as a CI or access failure, because of what its
  text says: a session whose files carry no `blockedBy` simply never shows «bloqueado» (the limit of the data).
- Tasks show their results as links, never invented ones (SC-5089): a PR/issue URL is shown only because a shell
  command of that task printed it (https only, no credentials, no query — where tokens travel), a Jira `browse/KEY`
  URL only from `*.atlassian.net` or the explicitly configured site, and a file only from a completed Write/Edit whose
  path still exists on the daemon host (shown as a path, not opened). The plugin does not fetch a URL to confirm it
  still resolves: it shows what the command produced, sanitized. The ticket title links to its browse URL only when
  `JIRA_SITE` is explicitly configured and valid (https, no credentials, no query, no path); without it the title is
  plain text — the plugin builds no URL from a guess.
- And as a `Plan` panel of the right-hand sidebar (Explorer), per agent, opened from «Ver en la barra lateral» at the
  top of the popover (Paseo lists agent panels in no menu). The pill, the popover and the panel start
  from Claude Code's own task files on the daemon host (`~/.claude/tasks/<session id>/`), so the plan is there in a
  long session and after a reload; the live rows then add each task's commands.
- One plan per approval: when Claude writes the list of a new plan (two or more tasks at once) after every earlier task
  was completed, that list is the plan of the pill and of the card. The earlier plans stay in the popover and the panel,
  above the current one, each folded to one line (`Plan 1 · 6/6 ▸`) that opens on tap. A single task added later
  belongs to the plan it follows.
- Commands run while no task is in progress go under "Otros comandos".
- Above the tasks, the popover and the panel show the plan of the session's ticket: its objective and its criteria with
  their state (`✓` verificada, `○` abierta) and evidence, or «Sin plan». The ticket comes from the worktree
  (`.claude/worktrees/<KEY>-…`), the branch or the first prompt. Its criteria, state and evidence come from
  `jira_rest.py criterios <KEY>` (read as `cto`), the same reader as the Done gate: a criterion is `verificada` once a
  `- [x] <criterio> — <prueba>` line backs it in the `## Evidencia` of a merged PR or in `50-entrega.md`. The objective
  is the `## Objetivo` of the description, else of the spec, else the ticket's summary. Without ticket criteria, the
  `## Plan`/`## Criterios` section of the worktree's `CLAUDE.md` or of the first prompt. It is rebuilt at every turn start and end and written to
  `~/.local/state/paseo-plan/anchor-<agentId>.json`, a file contract (`CONTRACTS.yaml`) read by paseo-sugiere and the
  harness Stop hook.
- «Garantizar plan» under the criteria switches `guard` in that file (off with no criteria); with it on, paseo-sugiere
  writes the next prompt against the plan.
- It replaces Paseo's own task rows and tool-call rows, so nothing is shown twice. Only Claude agents feed the card:
  with another provider you would lose the tool-call rows.
- Outputs are cut at 2000 characters and the whole row at 60 KB (oldest outputs go first).

Claude Code 2.1.x hides the task tools (`TaskCreate`, `TaskUpdate`) from the 5-series models. Set
`CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the provider environment, or the card has nothing to show.

## Install

```sh
paseo plugin add pocharlies-org/paseo-plan
```

Requires Paseo `>=0.11.2 <0.12.0`.

## Development

`npm ci --ignore-scripts && npm run typecheck && npm test`. The server half (`index.server.ts`, `server/plan.ts`)
folds the live timeline into one plugin row per agent; the client half renders it.

MIT licensed.
