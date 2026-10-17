# paseo-plan

While an agent works with a task list, its composer shows a **Plan** pill: how many steps are done and the one in
progress (`Plan 1/3 · Comprobando registros`). A tap opens the whole list — in progress, pending, done — and, when you
wrote after the agent last touched its plan, the line «Plan anterior a tu último mensaje». It is what Claude Desktop shows
as a box at the end of the conversation since v2.42304.0; Paseo plugins have no slot there, so it lives in the composer.

How it works: client only. The plan is Paseo's own `todo` timeline row (built from TodoWrite/TaskCreate/TaskUpdate and the
other providers' equivalents). Only running agents are followed: when a turn starts the plugin reads the last 200 rows of
that agent's timeline once and then folds the live rows; when the agent stops, the pill goes and the subscription is
released. Without a plan there is no pill.

Install: `paseo plugin add git:pocharlies-org/paseo-plan`. Update: `paseo plugin update`.
Needs Paseo 0.11.2 or a later 0.11 release.
