# paseo-plan

A Paseo plugin that shows Claude's task list at the end of the conversation, like Claude Desktop's plan box, with
what each task actually did: tap a task to open the commands it ran, tap a command to see its output.

- The task in progress is open by default and shows the live commands; the others stay closed.
- Commands run while no task is in progress go under "Otros comandos".
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
