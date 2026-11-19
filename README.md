# dsh-superagent

**Version 1.1.0** Â· [CHANGELOG](CHANGELOG.md) Â· [MIT](LICENSE) Â· [Contributing](CONTRIBUTING.md)

> **Research prototype for reference only, not an official DeepSeek product.** This code grew out of our team's day-to-day development work, with much of the engineering done by coding agents. Treat it as research code, not production-ready software. It may still contain bugs, and its coding style and engineering practices may be inconsistent. Review and adapt it before using it in your own environment.
>
> We have adapted it for publication, so it is not identical to our internal version or the implementation described in *Exploring Super-agent Design: Towards a More Autonomous Agent System*. Some designs discussed in the article are directions for future development and are not implemented in this prototype.

`dsh-superagent` is a proactive coding agent for **one GitHub repository**, packaged as a bundle (plugin) for [DeepSeek Harness](https://www.deepseek.com/en/harness/) (DSH). It listens to GitHub and, optionally, Feishu. When someone allowed asks the agent for work, it opens a work item, works on it in its own agent session and directory, and answers in the original conversation, for example with a pull request. A web panel shows what needs a person.

It is also a way of working with an agent: **take as little human attention as possible, and give as much value as possible.** An agent that can act for a whole team can also waste a whole team's attention, so it acts only when asked or when a rule the team wrote allows it, and speaks only when someone must act or can use a result. [docs/000-philosophy.md](docs/000-philosophy.md) explains the principle and what it asks of the operator.

## The problem it solves

A single chat session does not scale to a team: requests arrive from several places, everyone expects an answer in the thread they asked in, and one long-running agent either blocks on a single task or works on things nobody asked for. `dsh-superagent` splits that into three stored decisions:

1. **Where requests come from** â€?a *Source* (GitHub notifications and mentions, or Feishu chats) turns messages into *Triggers*.
2. **Who may ask** â€?a *Policy* decides whether a Trigger becomes a *Ticket*. Until an allowed list has someone on it, nothing becomes work.
3. **What happens next** â€?each Ticket runs in its **own DSH Session and directory**, and the result is delivered back to the conversation it came from.

## How it works (router / orchestrator)

The bundle defines two DSH agent presets, and they are the router/worker split:

- **`dsh-superagent-router`** â€?the main Session, reduced to routing: no shell, no sandbox and no job tools, a **read-only** filesystem (`write` and `edit` off), skills and compaction. It routes; it does not run commands. Also absent: subagents, file search, web, todo list, questions to a person, presenting, plan mode, plugin manager, scheduling, goals and workflows.
- **`dsh-superagent-worker`** â€?an Executor Session. It has the tools needed to do the work: writable filesystem, shell, file search, todo list, spawned subagents, web search without fetch.

A foreground command or job wait in a worker longer than **5 seconds** moves to a background job, so a long command does not hold back the next candidate. Neither preset can be hidden from the preset picker â€?DSH has no setting for that â€?so their names and descriptions say whom they are for. **Do not select them for personal Sessions.** See [cordis.patch.yml](cordis.patch.yml), [docs/003-execution.md](docs/003-execution.md) and [docs/007-architecture.md](docs/007-architecture.md).

The panel opens on **Router**: the conversation with the main Session, the worker Sessions a Ticket can borrow, and read-only plugin discovery. The other tabs are the work views. The panel and the host share a local HTTP API under `/orchestrator/api/`, documented in [docs/006-deployment.md](docs/006-deployment.md#management-api).

## Requirements

- **Node.js** `^22.19.0 || >=24.0.0` (see `engines.node`)
- **pnpm** (the `packageManager` field pins the version; corepack honors it)
- **DeepSeek Harness** within the `engines.dsh` range â€?currently `^0.2.1-alpha.2`. Because these are prerelease versions, DSH's own compatibility gate is strict: only DSH `0.2.1-*` prereleases are accepted.
- **git** 2.32+, **Python** 3.8+, **tmux**, and **GitHub CLI** 2.48+ (`gh`) on the host that runs the service
- A model provider configured in the DSH profile the service runs in
- A repository on **github.com** (GitHub Enterprise Server is not supported)
- Optional, for Feishu: `lark-cli` (tested with 1.0.90) and a Feishu/Lark app with a bot

## Install

> **Not published to npm.** This repository is distributed as source; `npm install dsh-superagent` will not work. The steps below build it locally and link it into a dedicated DSH profile.

```sh
npm install -g @deepseek-ai/dsh@0.2.1-rc.3
git clone https://github.com/ku-lin/dsh-superagent.git
cd dsh-superagent
pnpm install && pnpm build

# Create a dedicated profile (only for a new installation).
dsh superagent --from-default-profile web --dump-config > /dev/null
dsh plugin --profile superagent add "link:$PWD"

# Machine configuration: replace every <placeholder>.
cp examples/profile.cordis.patch.yml ~/.dsh/profiles/superagent/cordis.patch.yml

scripts/dsh-superagent start
```

`scripts/dsh-superagent start` runs `dsh --profile superagent` in tmux session `dsh-superagent` and waits up to a minute for the runtime to be ready or to report a setup requirement. Opening the URL printed in the log and choosing **Superagent** in the sidebar shows the panel.

Keep this profile separate from the one you work in: the plugin changes process-wide `PATH` and git configuration, and its process needs independent restarts and upgrades.

**Setup is interactive by design.** The full path â€?accounts, agent GitHub CLI wrappers, Feishu bot, settings, verification â€?has many steps, so an agent walks through it with you. Ask your coding agent:

> Read SETUP.md in this repository and set up dsh-superagent with me.

## Minimal example

After setup reports no outstanding requirement (`scripts/dsh-superagent status` exits 0), from a GitHub account on the allowed list:

1. Open an Issue, or post a comment, containing `@<agent login> <request>`.
2. Within one polling interval (a minute by default), the panel's **Overview** shows a Ticket.
3. The agent acknowledges in the thread, works in its own Session and directory, and delivers there â€?for example as a pull request.

On GitHub, a mention added by *editing* an existing Issue body is not received; post a new comment instead.

## Configuration

Two layers, and they are deliberately separate.

**Machine configuration** â€?`~/.dsh/profiles/<profile>/cordis.patch.yml`, copied from [examples/profile.cordis.patch.yml](examples/profile.cordis.patch.yml). This needs a restart to change.

| Key | Required | Meaning |
| --- | --- | --- |
| `stateDir` | yes | Absolute path: database, lock, command shims in `worker-bin`, the agent's git configuration and, by default, Ticket directories in `work`. Back it up before upgrades. |
| `promptMaxChars` | no | The largest saved prompt configuration. |
| `admissionContextMaxPages` | no | How many Thread pages one assessment reads. |
| `admissionContextTimeoutMs` | no | How long that assessment may take. |

`stateDir` accepts any absolute form the host recognizes (`/srv/dsh-superagent`, `C:\dsh\superagent`, `C:/dsh/superagent`, `\\server\share\superagent`); a relative path or `~/dir` is refused at startup. After the first start, the machine limits are editable in **Settings â†?Deployment**; `stateDir` is not.

**Application settings** â€?edited in the panel, or through the local API (`PUT settings/<block>`). No restart for most of them.

| Block | Holds |
| --- | --- |
| `source:github` | `repository` (`owner/name`), `cli`, and the observe switches `observeIssues`, `observePulls`, `observeComments`, `observeCi` (all off by default) |
| `source:feishu` | `cli`, `chats` (`chatId`, `name`, `listen` = `mentions` or `all`), `directMessages`, `otherChats` |
| `policy` | `rules`, and per Source the `allowed` list, `bots`, and per-chat/per-channel `admission` defaults |
| `executor` | `model`, `maxWorkers`, `directory`, `prepare`, `blockedCommands` |
| `eval` | `mode`, `timeoutSeconds`, `model` |
| prompts | team sections: GitHub disclosure line, review bots, commit author, auto-merge condition |

See [docs/006-deployment.md](docs/006-deployment.md) for the full API, the block contents and the troubleshooting table.

## Permissions and security

Read this before you run it on a machine you care about.

- **No isolation from the operator.** Both presets run with `danger-full-access` as the operator's OS user, read messages from subscribed Threads, and a worker can execute programs by path and read the operator's home directory. Account wrappers choose the agent's credentials; they do **not** sandbox the process. If you need isolation, use a dedicated OS account that contains only the agent's credentials. ([docs/006-deployment.md](docs/006-deployment.md))
- **A dedicated GitHub account is required, not recommended.** The agent comments, pushes and opens pull requests as that account. A GitHub App cannot be the agent, because the agent reads the account's notifications. Point it at a CLI wrapper that uses only that account's credentials.
- **Credential handling.** Setup writes command shims into `<stateDir>/worker-bin` (first on `PATH`) and a git configuration into `<stateDir>/worker-gitconfig` that replaces the operator's global and system git configuration. It removes environment variables whose names contain `KEY`, `PASSWORD`, `SECRET` or `TOKEN`, removes `GH_TOKEN`/`GITHUB_TOKEN`, and configures git never to prompt. A file in either directory that `dsh-superagent` did not write stops setup.
- **Local HTTP only.** The API binds to loopback (`127.0.0.1`/`localhost`) and requires the `x-orchestrator-request: 1` header; a request with a foreign `Origin` gets 403. It is not authenticated beyond that â€?treat any local process as able to drive it.
- **What the agent can be talked into.** The Policy is the only barrier between a chat message and a Session that can run commands. Start with a short allowed list.

## Compatibility

| | |
| --- | --- |
| DeepSeek Harness | `engines.dsh: ^0.2.1-alpha.2` â€?the published code is exercised against **DSH 0.2.1-rc.2** |
| Node.js | `^22.19.0 \|\| >=24.0.0`; CI covers 22.19 and 24 |
| GitHub | github.com only; GitHub Enterprise Server is not supported |
| Feishu | optional; `lark-cli` 1.0.90 per the deployment guide |
| OS of the service host | **POSIX** for `scripts/dsh-superagent` (it uses `fcntl`, `ps` and tmux) â€?see limitations |

Because `engines.dsh` names a prerelease, DSH's compatibility gate rejects newer minor lines. A database migrated by a newer version cannot be opened by an older one: back up `<stateDir>/orchestrator.sqlite` before upgrading.

## Known limitations

Honest list â€?several of these are the difference between "runs" and "supported".

- **Research prototype.** Not production-ready, not an official DeepSeek product, and reviewed by nobody outside its authors. Expect bugs.
- **`scripts/dsh-superagent` is POSIX-only.** It imports `fcntl` and shells out to `ps`/`tmux`. On Windows use it under WSL, or start the profile yourself and skip the script's log and control handling.
- **Not on npm.** Install is from source and needs a build step; there is no versioned artifact on the registry yet.
- **Exact peer versions.** The `@deepseek-ai/*` peer dependencies are pinned to the `0.2.1-alpha.2` line (`@deepseek-ai/cordis` to `4.0.5-alpha.1`, `@deepseek-ai/schemastery` to `3.18.5-alpha.1`). A newer DSH may refuse the bundle.
- **One repository per installation.** The GitHub Source takes a single `owner/name`.
- **End-to-end flows are not covered by the test suite.** The tests exercise units and the panel against fixtures; the GitHub and Feishu round-trips need real accounts, a real bot and a real repository, and are not verified in CI.
- **CI cannot validate DSH runtime behavior.** It typechecks, runs unit tests and checks the package contents; DSH itself is not booted in CI.
- **The suite has poll-based tests.** Several source tests wait on real subprocesses with `waitFor` timeouts, so CI retries the suite once as insurance on a loaded runner.
- **`pnpm build` is required before `npm pack`/`npm publish`.** `lib/` is a build output and is not committed.
- **English and Chinese UI only** (`locale/en.json`, `locale/zh.json`).

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

- [000 Philosophy](docs/000-philosophy.md)
- [001 Domain model](docs/001-domain.md)
- [002 Authorization](docs/002-authorization.md)
- [003 Execution](docs/003-execution.md)
- [004 Prompts](docs/004-prompts.md)
- [005 Panel](docs/005-panel.md)
- [006 Deployment](docs/006-deployment.md) â€?manual setup, configuration, upgrades, troubleshooting
- [007 Architecture](docs/007-architecture.md)
- [008 Cookbook](docs/008-cookbook.md) â€?adding a Source

## Development

```sh
pnpm install
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsdown -> lib/
pnpm check       # all three
```

`pnpm build` writes `lib/`, which `package.json` ships through `files`; check the result with `npm pack --dry-run`. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Provenance and changes

This repository repackages, for publication as a standalone plugin repository, the MIT-licensed research prototype published at [`deepseek-ai/dsh-superagent-prototype`](https://github.com/deepseek-ai/dsh-superagent-prototype). The code is theirs; the copyright notice in [LICENSE](LICENSE) is unchanged.

Changes made here, relative to that upstream snapshot:

- Packaging metadata for standalone publication: `private` removed; `repository`, `bugs`, `homepage`, `keywords` and `publishConfig` added; `files` extended with `docs`, `SETUP.md`, `examples` and `CHANGELOG.md`; a `prepublishOnly` build hook.
- Added `CHANGELOG.md`, `CONTRIBUTING.md`, `.gitattributes` (LF for every text file), a GitHub Actions workflow (typecheck + test + `npm pack --dry-run`), and a wider `.gitignore`.
- This README was restructured to state install steps, configuration, permissions and limitations explicitly; the code itself was not modified.

Future fixes belong upstream if they are general, and here if they are about packaging.

## License

[MIT](LICENSE) Â© DeepSeek Harness Team.
