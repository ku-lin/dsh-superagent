# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this package ships inside DeepSeek Harness, the `engines.dsh` range is part
of the compatibility surface: a change that raises it is a breaking change. The
`1.x` line is the first published line; the upstream prototype it is based on called
itself `0.1.0`, which is why this repository starts at `1.0.0` instead.

## [1.2.7] - 2026-11-21

The Router's right-hand side now carries the Taskboard's task list, and it is kept current by a push channel instead of
a timer. A worker that stops because of an error is reported to the Router by a fixed code path, never by a model.

### Added

- **A task-list rail beside the Router panel.** `GET tasks` answers every Taskboard project with its tasks — the
  identifier, the title, the status, the priority and when it last changed — and the panel draws it as a collapsible
  rail (280px, one column below 1080px) on the right of the management panel. A project selector and a refresh button
  sit at the top with the time of the read; the summary counts `进行中 / 待审 / 阻塞`; each row carries a status badge
  — todo grey, in progress blue, in review violet, blocked red, done green, canceled struck through — and finished
  tasks are hidden until "显示已完成" is on. It keeps its own switches across a panel remount and folds to a
  one-column tab that keeps its count.
- **The route is read-only and never repairs the board.** Every read opens `node:sqlite` with `readOnly: true` and
  closes it in the same call, so it can neither write nor rewrite a WAL; the answer is cached for five seconds, and a
  board change clears that cache. `?project=<key>` narrows the answer to one project by its key, ignoring case. The
  board's location is the mounted Taskboard service's own `config.databasePath` when it can be read, then
  `$DSH_HOME/taskboard.sqlite`, then `~/.dsh/taskboard.sqlite`, so a profile that pins an absolute path is followed
  and dsh-superagent keeps no dependency on the Taskboard package.
- **A board that is not there is a sentence, not an error.** A missing store, an unreadable file or a locked database
  answers `available: false` with one line of detail: the rail shows it and the rest of the panel, including the
  Router conversation, keeps working. No error toast, no thrown request.
- **A live channel, so the panel stops polling.** `GET /orchestrator/api/stream` is one Server-Sent Events stream per
  open panel: it opens with a `hello` frame carrying the current revision of every topic, then pushes a `change` frame
  naming the topic that moved (`tasks`, `tickets`, `failures`, `overview`, `settings`). The host publishes after the
  write commits, so a rolled-back transaction announces nothing. DSH's own web server already supports this — a prefix
  route may hold its response open, and its gzip middleware skips `text/event-stream` — so no second listener and no
  change to `node_modules` were needed. The route is registered separately from the JSON routes: a host that refuses it
  loses only push updates.
- **The task rail is event-driven, and says so when it is not.** The thirty-second `GET tasks` poll is gone; the rail
  reads once on mount and again when the host announces a board change. When the stream cannot open or drops, the rail
  shows 「已断开：不会自动刷新，请手动刷新」 with a manual refresh button, and **nothing polls in its place** — a silent
  fallback would hide the very failure that state reports. The connection retries on a bounded backoff, so it recovers
  by itself once the host is back.
- **A deterministic failure report, with no model in the loop.** `FailureLog` (`src/app/failures.ts`) records one
  structured alert per incident and queues it for the Router through the existing `relay` effect, so a stopped Router
  holds the alert instead of losing it and a restart keeps it. The records are also the answer to
  `GET /orchestrator/api/worker/failures` (newest first, `?ticket=` and `?kind=` narrow it), which the panel lists as
  「异常」 beside the Router workspace with the kind, the ticket, the exit code, who reported it and when.
- **Five code paths record a failure, each because an event said so:** a worker conversation disposed while its
  assignment still ran (`crash`); a turn the host closed with reason `error` (`turn-error`); `agent/error` that no
  transient retry covers (`agent-error`, or `exit` when the error carries an exit code); a worker's own
  `orchestrator_report` of `failed` or `blocked` (`report-failed` / `agent-error`); and a background job that settled
  `failed` (`exit` with its code, else `crash`). A failed launch adds `launch`, `timeout` (a prepare command that hit
  its ten-minute bound, judged by the error's cause rather than by its call site) and `exit`.
- **`scripts/report-failure.mjs`, so an external process reports the same way.** `--ticket`, `--session`, `--kind`,
  `--detail` and an optional `--exit-code` go to `POST /orchestrator/api/worker/failure`, which is same-origin fenced
  like every other write (`x-orchestrator-request: 1`, credentials omitted). Exit codes: `0` recorded or deliberately
  suppressed as a duplicate, `1` the host refused or was unreachable, `2` the arguments were wrong. `--url` selects the
  host, defaulting to `DSH_SUPERAGENT_URL` or `http://127.0.0.1:3082`. A repeat of the same ticket, session and kind
  inside sixty seconds answers `{ recorded: false, duplicate: true }` rather than failing, and that window is what keeps
  one incident's several paths from waking the Router with several alerts.

### Changed

- **The task rail no longer polls.** It reads once on mount, when the host announces a board change, and when a person
  presses refresh. A burst of announcements costs one request, and an idle panel costs none.
- **A worker that reports `failed` or `blocked` reaches the failure log in the same transaction as its report**, so the
  panel's 异常 list and the Router's queue can never disagree with the ticket. The report's own relay is still queued
  first, so what the main Session reads first is unchanged.
- **A prepare command's failure keeps its cause.** `PrepareFailed` now carries the original error, which is what lets
  the log tell a timeout apart from a non-zero exit instead of guessing from the message.

Operator control over the Router conversation: stop it, start it again, and delete the conversations this plugin owns.
All three writes are audited, require the panel's same-origin request header, and live under `/orchestrator/api/`.

### Added

- **Stop and start the Router from Settings › Superagent.** `POST router/stop` records `paused: true` with an optional
  reason and `POST router/start` clears it; `GET state` reports the switch as `router`, next to — and separate from — the
  Executor's own `paused`. Stopping deletes nothing and loses no history: every message bound for the Router conversation
  waits in the durable effect queue (the `relay` effect's new `queue` delivery) and is handed over in arrival order once
  the Router starts again. Running Tickets and their workers keep working, because the Executor's gate is untouched.
- **Delete a worker or router-level conversation.** `DELETE sessions/:id?confirm=true` archives the conversation, stops
  its work, detaches it from every Workspace that accounted for it, drops its projection-cache row and removes its stored
  log when the persistence backend exposes a root. `confirm` is required, and the permanent Router conversation refuses to
  delete itself — the panel offers no button for it either. A conversation this plugin did not create is refused, so a
  person's own conversations are never touched. The report says what happened, including whether the log was `removed`,
  `absent` or `retained` (with the reason).
- **The same three operations as model tools** (`orchestrator_router_stop`, `orchestrator_router_start`,
  `orchestrator_session_delete`), each describing the explicit human request it needs. A no-op is answered as a refusal
  carrying the current state, instead of failing the turn.
- **An audit trail** of the panel's and the tools' writes (`router-switch` and `audit` in the store, newest 200 kept),
  naming the operation, its target, the origin and whether it took effect.

### Changed

- `POST router-chat` answers `{ sent: true, queued: true }` while the Router is stopped, so the panel can say the message
  is waiting rather than delivered. A worker's answer to the Router goes through the same queue instead of waking it.

### Notes

- `router/stop`, `router/start` and `DELETE sessions/:id` are served by the host, so a running DeepSeek Harness picks them
  up only after it restarts; the Settings buttons need a page reload (or a client-plugin HMR rebuild) as well.

## [1.2.5] - 2026-11-21

### Changed

- Move Superagent management access into Settings › Superagent. The section opens the existing management console and keeps the Router group locator, duplicate-row visibility switch and router conversation list.
- Remove the Router workspace rail entry and Router footer action. The virtual Router group remains at the bottom of the workspace list.

## [1.2.4] - 2026-11-21

A display rule only: a worker conversation is no longer listed in the virtual Router workspace. It stays where it was
created — in the Workspace its ticket works in — so the Router group lists the Router's own conversations and a worker is
found under the workspace it belongs to. Worker creation, naming, routing, presets, the bundle id and the
`/orchestrator/api/` surface are unchanged, and there is no data migration.

### Changed

- **A worker stays in its own Workspace instead of the Router group.** `selectRouterSessions` selects only Sessions whose
  header ran the router preset; the worker preset, the `worker-` id prefix and the `worker-` projected title no longer
  make a Session a member (derived Sessions are still excluded). `GET router-sessions` therefore answers with the
  Router's own conversations and no worker row.
- **The group hides only the rows it renders, and only while it is in sight.** The suppression rule names the listed
  conversations alone — a `worker-` row is never named, even from a host older than the bundle that still answers with one
  — and is skipped while the group is folded or scrolled out of view (the group is pinned to the end of a populated
  workspace list), so a conversation is never hidden behind a group the person cannot see. The rule is recomputed when the
  sidebar scrolls or resizes.
- **A worker title in the Router transcript still opens that conversation.** The transcript linkifier now reads titles
  from the Router's own rows plus the management catalog (`dsh-sessions`), which lists worker Sessions, instead of from
  the group's membership (see `src/client/session-links.ts`).

### Notes

- `router-sessions` is served by the host, so a running DeepSeek Harness picks the new membership up only after it
  restarts; the client bundle needs a page reload (or a client-plugin HMR rebuild) as well.
- `tests/router-sessions.spec.ts` pins the new rule with this machine's worker (`worker-3e7503559090ac72f7c4d26f95654fee`)
  and `tests/router-workspace.spec.tsx` pins that a worker's native row is never named by the rule, that a folded group
  hides nothing, and that a group scrolled out of sight hides nothing.

## [1.2.3] - 2026-11-20

Fixes the sourceless deployment: a Router-only installation (no GitHub or Feishu Source configured) accepted a Ticket and
then never ran it, because "no Source" was read as "not set up". `engines.dsh`, the bundle id, the preset ids and the
`/orchestrator/api/` paths are unchanged; there is no data migration.

### Fixed

- **A deployment with no Source executes the Tickets it is given.** `Setup.sourceless` left `configured()` false, so
  `Runtime.paused()` stayed true and the Executor's `launch` handler reported a concurrency limit of 0: a ready Assignment
  was enqueued and never dispatched, and no worker Session ever appeared. `Setup.ready()` now separates the two states —
  a resolved Deployment, or a deliberate deployment with no Source at all — and the Executor's launches and input
  deliveries are held on `ready()` instead of `configured()`; a person's Ticket ran nowhere until now.
- **A Deployment that did not resolve still holds everything.** `ready()` is false while setup recorded a problem
  (`setupPending`, a missing repository or CLI, a foreign file in the state directory), so an installation that is half
  configured still starts no worker, keeps its effect queue, and polls nothing: the safety this bug traded on is intact.
- **A pass runs, and keeps due effects moving, once setup has finished.** `Passes` gates on the same `ready()` rather
  than on `configured()`, so a launch deferred by a full worker-slot budget or a parking lease is retried by the two-second
  tick instead of waiting for an effect that never runs; each effect kind still holds itself at limit 0 while it cannot run.
- **A worker's tools and environment no longer read a Deployment that does not exist.** `orchestrator_report`'s
  `pr_number` description named the agent's GitHub account at registration, so creating a worker Session in a sourceless
  deployment threw `dsh-superagent is waiting for setup` and failed the Ticket; `ticketEnvironment` also required the
  resolved Deployment. The account is named only when setup resolved one, and a Source's environment values (which are
  the only ones that read the Deployment) are simply absent, while the Executor's own variables such as
  `DSH_SUPERAGENT_DIR` stay.

### Tests

- A sourceless restart over a Ticket whose worker was interrupted now starts that worker again, with its directory
  prepared and its Assignment running; the same restart with a Source whose CLI is missing starts none.

## [1.2.2] - 2026-11-20

Makes a worker conversation findable from the Router the moment it exists: the title is committed at creation and
verified, and the Router's conversation names the worker with a link that opens it. Also fixes a restart defect: a
process that was killed leaves its state directory lock behind, and the next start now waits that lock out instead of
failing to mount the plugin, whose `/orchestrator/api/` routes then answered 404 and whose panel said it did not respond.

### Fixed

- **A worker is named when it is created, not after it is composed.** `session.create` takes no title, and DSH lists a
  Session as 未命名 until a `session/title` event lands. `Sessions.ensure` now renames immediately after creating the
  Session (before the role model, prompt sections, skills and tools are loaded), then again at the end, and each attempt
  is read back from the title service and retried once: a rename that the host dropped is logged instead of leaving a
  nameless row in the sidebar and in the Router workspace group.
- **The title fits the host's own budget.** The ticket's words are clipped to 56 UTF-8 bytes, so DSH's 80-byte limit
  never cuts the `worker-<id8> · ` prefix or a CJK character in half.
- **A start waits out the state directory lock its killed predecessor left.** The stale window is 5 seconds now (it was
  30) and a start makes up to ten attempts, one second apart, so a lock directory that stopped being refreshed at the
  kill ages out inside the wait instead of refusing the start: the reported cases had its mtime 7 s, 13 s and 16.5 s
  behind, inside the old window and outside the new one. The wait is synchronous and lasts about ten seconds at most.
- **A lock that is still held no longer unmounts the plugin.** Rather than throwing out of the Runtime, the start records
  `runtime` health as `lockWait` with the lock's path and the holder's last refresh, logs the same, and registers
  `/orchestrator/api/` anyway: every route answers 503 with that health entry and with the lock's path, attempts and
  wait, so the panel and `scripts/dsh-superagent status` read "waiting for the state directory lock" instead of the 404s
  of routes that were never mounted. Source plugins stay mounted too: their kinds register, and their polls stop at
  `configured() === false`.
- **The `runtime` entry tells three states apart:** `starting` while the application boots, `starting` with the
  `lockWait` code while another process holds the state directory, and `error` with the `lockError` code when the
  directory cannot be locked at all.

### Added

- **A worker's report carries its conversation.** `worker_report` and `worker_attention` relays, and the
  `orchestrator_worker_list` and `orchestrator_worker_message` results, now include
  `worker: { session, title, link }`. `link` is a Markdown link whose label is the worker's title, and the Router is
  told to copy it into what it tells a person.
- **The link opens the conversation.** DSH's Markdown renderer hands `http(s)` links to the browser and drops any other
  scheme, so the client bundle turns every worker title it knows into a button that opens that Session through
  `uiWorkspace.openSession` — the same navigation the sidebar rows use, so the Router's page stays in history. It also
  intercepts a `dsh://session/<id>` anchor whenever a host does render one.

## [1.2.1] - 2026-11-20

Fixes the 1.2.0 worker defect: worker conversations were never created, so a ticket
ran nowhere and nothing appeared in the Workspace list. `engines.dsh`, the bundle id,
the preset ids and the `/orchestrator/api/` paths are unchanged; there is no data
migration.

### Fixed

- **A worker conversation is created again.** 1.2.0 passed both `workspaceId` and
  `cwd` to `session.create`, which DSH refuses (`session.create accepts workspaceId
  or cwd, not both`), so every worker launch failed before the Session existed. A
  worker is now created with `workspaceId` only: DSH derives the directory from
  `workspace.path`, exactly as it does for a conversation a person starts by opening
  that directory.
- **A worker joins the Workspace for its ticket's directory**, not the Workspace the
  client happens to show. The directory is compared on its canonical form (resolved,
  separator-normalized, case-insensitive on Windows) against every registered
  Workspace; a directory that has no Workspace gets one registered the way opening it
  would. The conversation therefore lands in that Workspace's `sessionIds`, so it is
  listed, openable, and resumable.
- **The ticket directory is no longer the Session's `cwd`.** It stays what the
  Executor prepares and writes (worktree, logs, evidence); the Session's directory is
  the Workspace root, which is also where the worker's shell starts.

### Changed

- **One worker per Workspace at a time.** A launch whose Workspace already holds a
  worker is parked behind it and re-enqueued when that Workspace frees (checked every
  five seconds); different Workspaces keep running in parallel. Parking holds no global
  worker slot, so a long worker cannot starve unrelated directories.
- **Known limitations are documented.** The worker's shell starts at the Workspace
  root, and `danger-full-access` means no filesystem fence around it (README).

### Upgrade notes

1. **Open tickets recreate their worker on their next launch.** 1.2.0 never created
   one, so there is nothing to migrate; a ticket that failed to launch retries with the
   new placement. Nothing is deleted.
2. **Conversations from 1.1.0 stay where they are.** A worker created by 1.1.0 keeps
   its `cwd`; only new Sessions are created with a Workspace alone.

## [1.2.0] - 2026-11-19

A worker becomes an ordinary conversation you can find and talk to, and the Router
talks to it instead of waiting on subagents. `engines.dsh`, the bundle id, the preset
ids and the `/orchestrator/api/` paths are unchanged; there is no data migration.

### Changed

- **A worker conversation lives in the Workspace you have open.** `Sessions.ensure` joins
  the Workspace the client shows as its default and keeps the ticket's directory as the
  Session's `cwd`, instead of creating one Workspace per ticket directory. A worker is
  titled `worker-<id8> · <ticket title>`, so it is findable in the list, openable, and
  resumable like any other conversation.
- **A worker spawns no subagents.** `subagent`, `list_subagent_models`, `send_message`,
  `list_agents` and `interrupt_agent` are gone from `WORK_TOOLS`, and the worker preset
  loses its delegation group. A worker reports through the ticket's own
  `orchestrator_*` tools.
- **A turn's end no longer waits on subagents.** `untilQuiet` only waits for the worker's
  own shell jobs; a leftover child of a borrowed conversation cannot hold a ticket open,
  and the 30-minute limit no longer reports "subagents still ran".
- **The Router talks, it does not wait.** `orchestrator_worker_message` now defaults to
  `wait_seconds: 0`: the message is handed over and the call returns at once, and the
  worker's answer is delivered back into the Router's own conversation when that turn ends
  (`answerLater`). A positive `wait_seconds` still asks for the answer inline.

### Upgrade notes

1. **Worker conversations move into your Workspace.** After the upgrade, open tickets
   recreate their worker in the Workspace the client shows, not in a Workspace per ticket
   directory. Conversations created by 1.1.0 stay where they are; new turns use the new
   place. Nothing is deleted.
2. **Workers can no longer spawn subagents.** A worker that used `subagent` will find the
   tool gone; work that needs delegation must be split into tickets, or done by a person's
   own session. Prompt text that mentions subagents in a worker has been removed.
3. **`orchestrator_worker_message` changed meaning for its default.** Omitting
   `wait_seconds` no longer blocks up to 120 s; it returns as soon as the message is
   handed over, and the answer arrives later as a message in the Router's chat. Pass a
   positive value to keep the old inline behaviour for a specific call.

### Tests

`bundle-patch.spec.ts` now requires the worker preset to have no delegation tools;
`runtime-concurrency.spec.ts` gained a workspace/name/message-contract group; the
background and concurrency cases that encoded "a ticket waits for its worker's subagents"
were re-specified to "a leftover child does not hold a ticket open", keeping the
shell-job coverage. Nothing was skipped or deleted.

## [1.1.0] - 2026-11-19

Merges the router panel work that was still uncommitted in the development tree, and
makes the router preset a pure dispatcher. `engines.dsh` and the bundle entry points
are unchanged; the changes below are additive or affect only the panel and the router
preset.

### Added

- **The Router page, now the panel's home.** It shows the conversation with the main
  Session (opened in DSH's own chat view), the worker Sessions a Ticket can borrow with
  their status (running, borrowed, idle, unavailable), and read-only plugin discovery
  through an index URL and a text search.
- API routes behind it: `GET dsh-sessions`, `GET router-chat`, `GET router-events`,
  `GET router-event-sample`, `POST router-chat`, `GET plugin-indexes`, `GET plugin-search`
  and `POST tickets/:id/worker-session`, which binds a borrowable Session to a Ticket that
  has not started.
- The sidebar entry and the Router tab read `Router` instead of `Superagent` (the bundle,
  the presets and the API paths keep their `dsh-superagent` names).

### Changed

- **The router preset no longer runs commands.** It lost the shell group, the sandbox and
  the job tools; it keeps a read-only filesystem, skills, instructions, time context and
  compaction, and dispatches through `orchestrator_*`. A shell in the router was what let
  it work instead of routing. The worker keeps the 5-second backgrounding rule.
- The panel opens on Router. A route remembered by 1.0.0 is deliberately not reused
  (the storage key is now `dsh-superagent/route.v2`), so the first open after upgrading
  lands on Router instead of a stale page.
- A Session the client catalog does not list is now opened directly rather than reported
  as missing: the router owns its own Session, which the catalog does not always carry.

### Fixed

- `LICENSE` now records the released versions (`Released as dsh-superagent 1.0.0` and
  `1.1.0`) under the unchanged upstream copyright line.

### Tests

The suite is green again; nothing was skipped or deleted. Where the product contract
changed, the assertion was re-specified to the new contract and, where coverage would
otherwise be lost, extended:

- `bundle-patch.spec.ts` — the router preset assertions now require the absence of
  `tool-bash`, `tool-pwsh`, `bash-sandbox`, `pwsh-sandbox` and `tool-jobs` in the router
  (and their presence in the worker), matching the new preset.
- `client.spec.tsx` — the sidebar label is `Router`; the "Session not listed" case became
  "opens a Session the catalog does not list directly", plus a new case for a catalog that
  is not ready (which still reports in the interface language).
- `navigation.spec.ts` — uses the exported `ROUTE_KEY` instead of a hardcoded key and
  expects the new home page for an unknown saved route.
- `panel-execution.spec.tsx`, `panel-panel.spec.tsx`, `panel-eval.spec.tsx`,
  `panel-source.spec.tsx` — navigate to the page each test is about, since the panel now
  opens on Router; the tab list includes Router.
- `styles.spec.ts` — the new Router rules follow the one-rule-per-line convention of the
  panel stylesheet.

## [1.0.0] - 2026-11-19

First public release of this repository. It repackages the MIT-licensed research
prototype from [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype)
(upstream commit `8c32a9d`) as a standalone plugin repository.

### Added

- Standalone packaging: `private` removed, `repository`/`bugs`/`homepage`/`keywords`/
  `publishConfig` added, `files` extended with `docs`, `SETUP.md`, `examples` and
  `CHANGELOG.md`, and a `prepublishOnly` build hook so `npm publish` never ships a
  stale `lib/`.
- `README.md` restructured: install steps, minimal example, configuration reference,
  permissions and security notes, compatibility table and known limitations.
- `CONTRIBUTING.md`, this changelog, `.gitattributes` (LF for every text file, so the
  python3 `scripts/dsh-superagent` keeps a working shebang — the file also keeps its
  executable bit) and a wider `.gitignore` (state directory, sqlite/WAL, local
  secrets and editor noise).
- GitHub Actions CI: typecheck, unit tests and `npm pack --dry-run` on Node 22.19 and
  24, with one retry as insurance for the suite's poll/`waitFor` tests. It uses the
  public npm registry only and needs no secrets.

### Fixed

- `tests/sources.spec.ts` ("feishu event consumer: … reports a malformed line without
  stopping") asserted that the *last* health entry was the JSON error, but the error
  arrives on stdout while `[event] ready` arrives on stderr, and the two streams are
  not ordered against each other — on Linux the ready line is processed last, so the
  assertion failed on every run. The test now records every `ctx.report` and asserts
  the error was reported, which keeps its intent and drops the ordering assumption.
  Product behavior is unchanged.

### Notes

- The bundle entry points, agent presets (`dsh-superagent-router`,
  `dsh-superagent-worker`) and the `/orchestrator/api/` surface are unchanged, so an
  existing profile configured against the upstream prototype keeps working.
- Not published to npm; install from source with `pnpm install && pnpm build`. The
  name `dsh-superagent` is free on the registry, so a later release can claim it.
- `1.0.0` states "this is the released packaging", not "production ready": see the
  disclaimer and known limitations in `README.md`.
