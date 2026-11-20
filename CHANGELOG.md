# Changelog

All notable changes to this repository are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims at
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because this package ships inside DeepSeek Harness, the `engines.dsh` range is part
of the compatibility surface: a change that raises it is a breaking change. The
`1.x` line is the first published line; the upstream prototype it is based on called
itself `0.1.0`, which is why this repository starts at `1.0.0` instead.

## [1.2.1] - 2026-11-20

Fixes a hard regression in 1.2.0 and makes a worker conversation **identical to one a person
creates in that Workspace**.

### Fixed

- **1.2.0 created no worker at all.** It called
  `sessionController.create({ workspaceId, cwd, agentPreset })`, and DSH refuses both at once
  (`session.create accepts workspaceId or cwd, not both`), so every worker launch failed and no
  worker conversation ever existed. A second rule of the same API makes the 1.2.0 design
  impossible anyway: a Session that joins a Workspace takes **that Workspace's path** as its
  cwd, and the Workspace's own `attachSession` rejects a Session whose cwd is not its path.
  The plugin now passes **`workspaceId` alone**, exactly as creating a conversation in that
  Workspace does.

### Changed

- **The worker's cwd is the Workspace directory.** Relative paths, `git status` and build
  output land where they would in a conversation you start by hand. The ticket directory
  (`$DSH_SUPERAGENT_DIR`) is demoted to scratch for logs, evidence and temporary files; it is
  no longer the Session's cwd and the worker prompt says so.
- **New Execution setting `workspace`** (absolute path, empty by default). Empty means the
  Workspace the client shows; a path is resolved by `realpath` and matched exactly against
  the registered Workspaces, and a directory with no Workspace yet is registered for it —
  the same thing opening a conversation there does.
- **One worker per Workspace.** A lease is held from launch until the Assignment ends, so two
  tickets of the same repository never share a checkout; the second stays pending and is
  retried by the effect queue. Different Workspaces still run in parallel. With one
  repository configured, this means workers run one at a time regardless of `maxWorkers`.

### Upgrade notes

1. **Restart the dsh-superagent profile.** The change is in the plugin and in its presets.
2. **Workers run in your project directory now.** `danger-full-access` has no fence around
   it: a worker's shell can write anywhere in that checkout. README's Limitations say so
   plainly. Use a dedicated checkout or OS account if that matters.
3. **Ticket worktrees are no longer the working directory.** An existing `prepare` command
   still runs and its directory is still created, but it is scratch; a team that relied on a
   worker editing an isolated worktree should point `workspace` at the directory it wants
   workers to work in.
4. Concurrency drops to one worker per Workspace, as above.

### Tests

The fixture now mirrors both DSH rules — `create` refuses `workspaceId` with `cwd`, and
`attach` rejects a Session whose cwd is not the Workspace path — so this regression cannot
come back silently. New cases assert that a worker is created by `workspaceId` alone, that it
lands in that Workspace's `sessionIds` and in the Session catalog, and that a second ticket in
one Workspace stays pending. `cards.spec.ts` keeps the worker prompt under its character
budget after the prompt rewrite.

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
