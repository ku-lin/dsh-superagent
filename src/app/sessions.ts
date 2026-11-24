/** Lifecycle, prompt/tool/skill decoration, message delivery, and budget retry tracking for orchestrator and worker DSH sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import { scopeChainOf, scopeParentOf, type ScopeKey } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, normalize, resolve as resolvePath, sep } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { mandateInstructions, ticketOfSession } from '../executor/dsh.ts'
import type { HealthEntry } from '../infra/health.ts'
import { AgentDelivery, messageId } from './delivery.ts'
import type { Effects } from './effects.ts'
import type { Variable } from './execution-environment.ts'
import { RetryHealth } from './retry-health.ts'
import { initializeRoleModel } from './role-models.ts'
import { bundledSkills } from './skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from './prompts.ts'
import type { Store } from './store.ts'
import { KV } from '../kv.ts'
import { ROUTER_PRESET, WORKER_PRESET } from './router-sessions.ts'
import type { RegisterTool, Tool } from './tools/tool.ts'

/**
 * A directory in the form a Workspace stores: absolute, resolved through symlinks when it exists, and spelled the way
 * the filesystem reports it. A missing directory keeps its absolute spelling; the registry reports that case itself.
 */
async function canonicalPath(directory: string): Promise<string> {
  const absolute = resolvePath(directory)
  return await realpath(absolute).catch(() => absolute)
}

/** One directory spelling to compare: separator-normalized, trailing separators dropped, lowercased on Windows. */
function canonicalSpelling(value: string): string {
  const normalized = normalize(value).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** Whether two directory spellings name the same place. */
export function samePath(left: string, right: string): boolean {
  return canonicalSpelling(left) === canonicalSpelling(right)
}

/**
 * How deep `ancestor` sits above `target`: its spelling length, or `-1` when it is not a parent directory.
 *
 * The comparison is on whole path segments, so a Workspace at `/share` never claims a ticket in `/share2`, and the
 * length is what makes the deepest registered parent win when several of them contain the directory.
 */
export function ancestorDepth(ancestor: string, target: string): number {
  const parent = canonicalSpelling(ancestor)
  const child = canonicalSpelling(target)
  if (parent === '' || parent === child) return -1
  const boundary = parent.endsWith(sep) ? parent : parent + sep
  return child.startsWith(boundary) ? parent.length : -1
}

/**
 * The Workspace a ticket's directory belongs in: the exact one when it is registered, otherwise the deepest registered
 * parent of that directory, otherwise nothing (the caller registers it).
 *
 * A worker lands where a person would land by opening the directory and starting a conversation: at the repository
 * root's Workspace, not a new Workspace per worktree, and not a broad parent such as `/share` when a deeper one exists.
 * @param listed - the registered Workspaces, whose `path` may be absent for a record the host did not describe.
 * @param directory - the ticket's target directory, already resolved by the caller.
 * @returns the Workspace to join, or undefined when no registered Workspace contains the directory.
 */
export function nearestWorkspace<T extends { readonly path?: string }>(listed: readonly T[], directory: string): T | undefined {
  const exact = listed.find(item => item.path !== undefined && samePath(item.path, directory))
  if (exact !== undefined) return exact
  let nearest: T | undefined
  let deepest = -1
  for (const item of listed) {
    if (item.path === undefined) continue
    const depth = ancestorDepth(item.path, directory)
    if (depth > deepest) { deepest = depth; nearest = item }
  }
  return nearest
}

/** Host dependencies used by `Sessions`. */
export interface SessionsHost {
  /** DSH Cordis context: sessions, agents, persistence, and their events. */
  readonly context: Context
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports managed sessions waiting on a model-budget retry. */
  readonly health: HealthEntry
  readonly masterId: string
  /** Server-authoritative project Router binding; absent keeps the legacy single Router behavior. */
  managedRouter?(sessionId: string): { projectId: string; summary: string } | undefined
  /** Rechecked at execution time, including for an Agent decorated before a refresh. */
  managedRouterAllowed?(sessionId: string): boolean
  readonly lifetime: AbortSignal
  closing(): boolean
  /** Whether the Router conversation is stopped, which holds every message bound for it instead of dropping it. */
  routerStopped(): boolean
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt. */
  environment(ticket: Ticket): Variable[]
  /** Tools to register on the main Session (`ticket === undefined`) or on `ticket`'s worker Session. */
  tools(agent: Agent, ticket?: Ticket): Tool[]
  /**
   * The directory the Router's own conversations live and work in.
   *
   * A Workspace validates membership by comparing a Session's stored `cwd` with its own `path` exactly (see `attach`),
   * so this has to be a real directory registered as its own Workspace. Keeping it out of the project's checkout is what
   * stops the Router from being accounted to the deployment's Workspace, where every other conversation already sits.
   */
  routerDirectory(): string
}

/**
 * What Sessions registered for an agent it decorated: the releases of its prompt section, tools and skill scope, the scope
 * its skills are registered in, and the skills of one prompt revision; for a worker's subagent, only its tool limits.
 */
interface SessionBinding { disposers: (() => void)[]; scope?: Context; skills?: { revision: number; dispose: () => void }; subagent?: true }

/** The sidebar title of the Workspace the Router's conversations live in, instead of its directory's last segment. */
const ROUTER_WORKSPACE_TITLE = 'Router'

/** The agent presets Executor Sessions and the main Session are created with, which the bundle's patch defines. */
export { ROUTER_PRESET, WORKER_PRESET }
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** DSH's agent preset registry selected `agentPreset` for a Session. */
    'agent-preset/selected'(sessionId: string, agentPreset: string): void
  }
}
/**
 * The DSH tools an Executor Session works with: files, search, the shell and its jobs, the web, skills and its todo list. It
 * gets no other tool the profile has, whenever it was registered: none that asks or shows a person something, changes the
 * profile, schedules work or starts goals outside the worker slots, the pause and a person's hold, starts a subagent or
 * messages another Session, or edits documents. A worker talks to the Router through its own `orchestrator_*` tools, which
 * the ticket adds; it does not spawn or message Sessions of its own.
 */
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill', 'web_search',
  'web_fetch', 'skill', 'todo_write']
/**
 * Tools the router conversation keeps. It routes; it does not work. No shell, no job control, no writes: the only way it can
 * change anything is through its own `orchestrator_*` tools, which act on Tickets and other conversations. `read` stays for
 * reading a card or a resource it must judge, and the list is filtered by what the profile provides, because naming a tool the
 * profile lacks makes `restrict` throw and the Session cannot resume at all.
 */
const ROUTER_TOOLS = ['skill', 'read', 'read_image']
/**
 * Tools a main Router Session must never call, whatever its tool surface still lists.
 *
 * Each of these composes a child Agent and appends a `subagent`-origin Session; a Router that used one stopped being a
 * router, because the work left the ticket pipeline (no Ticket, no project archive, no row a person can manage).
 *
 * The names are the deployment's own, and there are two families:
 * - `dsh-tool-subagent` mounted as `subagent` (spawn) and `subagent_fork` (fork), `dsh-tool-workflow` (its `agent()`
 *   steps), and `delegate`, the historical name of DSH's delegation tool.
 * - AgentTeams, which is mounted here and reaches the same `ctx.subagents` provider: `spawn_teammate` starts a
 *   continuable child per member, and `team_task_*` drive members that already are such children.
 *
 * The second family is why the guard cannot be a name list alone for every profile: it is the one a person can still
 * see in a Router today (the profile's own 31-tool surface), so leaving it out would refuse nothing that matters.
 *
 * `restrict` cannot express any of this: it masks the INHERITED surface only, and these are mounted profile-wide, so
 * they stay visible in a scope that restricts them. The guard below runs per execution and covers every registration.
 */
const ROUTER_FORBIDDEN = ['subagent', 'subagent_fork', 'workflow', 'delegate', 'spawn_teammate'] as const
/** The reserved PTC presentation transport, which `restrict` refuses to name and which is never a module tool. */
const RUN_CODE = 'run_code'
/**
 * Tool names a Router must NOT inherit, so a mounted module's tools can reach it without widening the boundary.
 *
 * `restrict` masks everything a Session INHERITS, so superagent's flat `ROUTER_TOOLS` allow-list hid every tool a
 * mounted module contributed — the module layer measured exactly that as `reached-but-policy-denied`. The tools were
 * always reachable; only the mask was wrong.
 *
 * A deny-list is used rather than an allow-list naming the module's tools, because the set to hide does not depend on
 * WHICH module is mounted. `dsh-module-layer` emits no `tools/change`, so anything computed once at decoration time and
 * naming module tools goes stale: switching `ctf` → `forensics` left the `ctf` names admitted and the `forensics`
 * names hidden. This list only ever names what must stay out, so a module mounted or swapped later is visible
 * immediately, with nothing to recompute.
 *
 * Both terms come from layers at or BELOW the preset generation, which is precisely why no module can appear in them:
 * - the global layer, so no profile-wide tool (`bash`, `write`, `subagent`…) is ever reachable;
 * - the generation's OWN contribution (`schemas(generation) \ schemas(parent(generation))`), so a preset's own tools
 *   stay as restricted as they were — but `ROUTER_TOOLS` inside it is spared, since the Router keeps those.
 * A module layer sits ABOVE the generation in `[session, generation, module, …]`, so it is never subtracted.
 *
 * @param tools - the tool registry (`ctx.tools`).
 * @param agent - the Router's scope key (the Agent object, which DSH also uses as the scope key).
 * @returns the names to deny; never names a module tool.
 */
function routerDeniedTools(tools: { schemas(scope?: ScopeKey): { name: string }[] }, agent: ScopeKey): string[] {
  // A host without schema projection denies nothing extra, so the Router keeps `ROUTER_TOOLS` and its own registrations
  // exactly as before instead of losing tools to a derivation it cannot perform.
  if (typeof tools.schemas !== 'function') return []
  const names = (scope: ScopeKey | undefined): Set<string> => new Set(tools.schemas(scope).map(schema => schema.name))
  const denied = new Set<string>(names(undefined))
  // Index 1 of `[session, generation, module, …]`: the preset's generation, whose own tools the Router must not gain.
  const generation = scopeChainOf(agent)[1]
  if (generation !== undefined) {
    const above = names(generation)
    const below = names(scopeParentOf(generation))
    for (const name of above) if (!below.has(name)) denied.add(name)
  }
  for (const name of ROUTER_TOOLS) denied.delete(name)
  // `restrict` refuses to name the reserved PTC transport at all, and under PTC mode it is present in the global view this
  // derivation read, so it has to be dropped here or the whole restriction throws and the Session goes undecorated.
  denied.delete(RUN_CODE)
  return [...denied].sort()
}
/**
 * The Router's deny list, exposed for the test that pins the scope-chain interaction.
 * @param tools - the tool registry.
 * @param agent - the Router's scope key.
 * @returns the names a Router must not inherit.
 */
export const routerDeniedToolsForTest = routerDeniedTools
/** What a Router is told when it reaches for delegation: the route that keeps the work manageable. */
const ROUTE_NOT_DELEGATE = 'This Router dispatches work instead of spawning it: call orchestrator_worker_create to open '
  + 'an ordinary worker conversation, orchestrator_worker_message to talk to an existing one, or orchestrator_route '
  + 'to accept a source candidate. Do not create delegated child Sessions.'
/** What the main Session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with their output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** What a main Session under `standard` is told when its command would wait the shell's default. */
const DEFAULT_WAIT = 'This shell waits up to 60 seconds by default: pass timeoutMs of at most 30000, or run_in_background, '
  + 'as a waiting step holds back new candidates.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/
/**
 * The main Session's guard: it refuses a bash command that runs sleep or asks to hold the step longer than 30 seconds, and a
 * job wait longer than 5 seconds. Under `standard`, as a main Session created before the router preset runs, the shell holds
 * a command 60 seconds and a job wait lasts 30 seconds by default, so a command needs a timeout or the background, and a
 * job wait its timeout; the router preset ends both after 5 seconds.
 */
function noWait({ name, arguments: input }: { name: string; arguments: unknown }, routed: () => boolean): string | undefined {
  const args = (input ?? {}) as { command?: unknown; timeoutMs?: unknown; run_in_background?: unknown; wait?: unknown; timeout_ms?: unknown }
  if (name === 'bash') {
    const sleeps = typeof args.command === 'string' && SLEEP.test(args.command)
    if (sleeps || typeof args.timeoutMs === 'number' && args.timeoutMs > 30_000) return NO_WAIT
    if (args.timeoutMs === undefined && args.run_in_background !== true && !routed()) return DEFAULT_WAIT
  }
  if (name === 'job_output' && args.wait === true && (typeof args.timeout_ms === 'number' ? args.timeout_ms > 5_000 : !routed())) return NO_WAIT
  return undefined
}

/**
 * Creates and decorates orchestrator and worker DSH `Agent` sessions with role models, system prompt sections from `Prompts`, runtime skills, and restricted tool sets.
 * `Runtime`, `DshExecutor`, `MasterAssessor`, `Settings`, and management routes/tools use it to ensure sessions, deliver deduplicated messages via `AgentDelivery`, and process ordered `relay` and `notice` effects.
 * Feeds session events into `RetryHealth` to report model budget waits on the `models` `HealthEntry`, and durably records which prompt revisions each session has worked under in `Store` (`KV.sessions.prompts`) to authorize prompt version reads.
 */
export class Sessions {
  private readonly agentDelivery: AgentDelivery
  /** Decorated agents mapped to their registered disposers and skill scope until the agent is disposed or `Sessions.dispose()` runs. */
  private readonly bindings = new Map<Agent, SessionBinding>()
  /** Ticket tools added to an explicitly borrowed conversation without changing its existing prompt or tools. */
  private readonly borrowed = new Map<Agent, { ticketId: string; disposers: (() => void)[]; abort: AbortController }>()
  private readonly retryHealth = new RetryHealth()
  private readonly ctx: Context
  /** Registers ordered `relay` and `notice` effect handlers that deliver to the main Session. */
  constructor(private readonly host: SessionsHost) {
    this.ctx = host.context
    this.agentDelivery = new AgentDelivery(host.context)
    // Deliver relays and notices to the main Session in the order they were queued. A relay is held while the Router is
    // stopped: steering would start the Router's turn, and a queued one would too, so both kinds wait in the durable queue
    // instead — the row survives a restart, and a start hands it over in arrival order.
    host.effects.handle('relay', ({ text, queue, sessionId }, requestId) => this.prompt(sessionId ?? host.masterId, requestId, text, queue ? 'queue' : 'steer'),
      { ordered: true, limit: () => host.routerStopped() ? 0 : 1 })
    host.effects.handle('notice', ({ value, summary }, name) => this.inject(name, value, summary), { ordered: true })
  }
  /** Subscribes to host agent and session events so newly created sessions are decorated and model-budget retries are reflected in health. Call once at startup. */
  install(): void {
    const ctx = this.ctx
    ctx.on('agent/disposed', ({ agent }) => {
      this.releaseBorrowed(agent)
      this.release(agent)
      this.retryHealth.clear(agent.id); this.updateModelHealth()
    })
    ctx.on('session/event', (session, event) => {
      const agent = ctx.agents.get(session.id)
      const binding = agent && agent.session === session ? this.bindings.get(agent) : undefined
      if (!agent || !binding || binding.subagent) return
      this.retryHealth.observe(agent.id, event)
      this.updateModelHealth()
    })
    ctx.on('agent/created', async ({ agent }) => { await this.decorate(agent); return undefined })
    // Opening a Session in DSH's Web UI before its first turn may select the default preset for it: select ours again. After
    // its first turn DSH refuses any selection, which leaves it as it is.
    ctx.inject(['agentPresets'], child => {
      child.on('agent-preset/selected', (sessionId, preset) => {
        const ticketId = ticketOfSession(sessionId), agent = ctx.agents.get(sessionId as SessionId)
        // A Router is a Router whoever started it. DSH may stamp the profile's default preset on a conversation a person
        // opened by choosing Router in the picker, which silently demoted it to an ordinary Session with no dispatch tools
        // at all — the person then had a "Router" that answered it had no orchestrator_worker_create. Only a Session this
        // plugin owns (its Router, or a ticket's worker) is corrected; another plugin's or a person's own choice is not.
        const ours = sessionId === this.host.masterId ? ROUTER_PRESET
          : ticketId && this.host.store.tickets.get(ticketId) ? WORKER_PRESET
            : preset !== ROUTER_PRESET && agent !== undefined && this.routed(agent) ? ROUTER_PRESET
              : undefined
        // A person choosing Router is the one case that cannot be corrected by re-selecting later: DSH refuses `select()`
        // once the Session has started a turn (`agent-preset/locked`), and the picker choice happens before that turn. So
        // when the selection IS the router preset, install the router composition here instead of asking for a change.
        if (preset === ROUTER_PRESET && ticketId === undefined && agent !== undefined && sessionId !== this.host.masterId) {
          // Release first: a Session can be re-composed in place, so a binding left from an earlier composition would keep
          // its tools, prompt section and guards and make `decorate` return early — leaving this Router with the previous
          // (non-Router) surface. `release` is LIFO and idempotent, and a fresh decorate follows.
          this.release(agent)
          this.decorate(agent).catch((error: unknown) => ctx.logger.warn('dsh-superagent could not compose the Router Session: %s', String(error)))
          return
        }
        // Picking anything else releases what this plugin installed: its tools and guards belong to the role it had.
        if (preset !== ROUTER_PRESET && agent !== undefined && this.bindings.has(agent)) this.release(agent)
        if (!ours || preset === ours || !agent) return
        const presets = child.get('agentPresets') as { select(agent: Agent, preset: string): Promise<string> }
        presets.select(agent, ours).catch(() => {})
      })
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle' && !this.host.closing()) { this.retryHealth.clear(agent.id); this.updateModelHealth() }
    })
  }
  /**
   * Ensures a Session exists in one Workspace, composed for its role.
   *
   * The Session is created with `workspaceId` **only**: DSH refuses a create that names both a Workspace and a `cwd`
   * (`session.create accepts workspaceId or cwd, not both`), and the Workspace is what makes the conversation visible
   * and resumable — DSH derives the Session's working directory from `workspace.path`, exactly as it does for a
   * conversation a person starts by opening that directory.
   * @param id - the Session to resolve or create.
   * @param title - the title to set once composed.
   * @param role - which preset composes it.
   * @param workspaceId - the Workspace it joins; omitted only for a host with no Workspace at all.
   */
  async ensure(id: string, title: string, role: 'orchestrator' | 'worker', workspaceId?: string): Promise<Agent> {
    const ctx = this.ctx
    let result = await ctx.sessionController.resolveAgent(id as SessionId)
    let created = false
    if ('error' in result && result.error.code === 'session/not-found') {
      // A host with no Workspace at all still needs one: its own directory, the same Workspace opening it would make.
      const joining = workspaceId ?? (await this.defaultWorkspace())?.id ?? (await this.workspaceFor(process.cwd())).id
      // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml). No `cwd`: passing
      // both is rejected, and the Workspace already decides the directory.
      await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: joining as never,
        agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
      result = await ctx.sessionController.resolveAgent(id as SessionId)
      created = true
    }
    if ('error' in result) throw result.error
    // Named first: a Session without a `session/title` event is the 未命名 row the client lists, and the composition
    // below (role model, prompt, skills, tools) can take as long as the host takes to load them.
    if (created) await this.name(result.agent, title)
    const settings = this.host.store.settings()
    await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
    await this.decorate(result.agent)
    ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
    // Again last, and verified: DSH's title service pins an explicit title, but a host that lost the first attempt (or
    // renamed the conversation while composing it) must not leave the row nameless.
    await this.name(result.agent, title)
    return result.agent
  }
  /**
   * Give a Session its title and confirm the host committed it.
   *
   * `session.create` takes no title, and a Session is listed as 未命名 until a `session/title` event lands, so this runs
   * as soon as the Session exists and again after composing it. The attempt is verified against the title service's own
   * fold (`sessionTitle`), and retried once: an unverified call used to fail silently and leave the conversation nameless
   * in the sidebar and in the Router workspace group.
   * @param agent - the resolved Session, whose `session` is the log the title is folded from.
   * @param title - the name the conversation must carry.
   */
  private async name(agent: Agent, title: string): Promise<void> {
    const committed = (): string | undefined => {
      try {
        const service = this.ctx.get('sessionTitle') as { get?: (session: Agent['session']) => { title?: string } | undefined } | undefined
        const current = service?.get?.(agent.session)?.title
        return typeof current === 'string' ? current : undefined
      } catch { return undefined }
    }
    // The host keeps a title within its own byte budget, so a committed title is a prefix of what was asked for.
    const applied = (value: string | undefined): boolean => value !== undefined && value !== '' && (value === title || title.startsWith(value))
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const renamed = await this.ctx.sessionController.rename({ sessionId: agent.id as SessionId, title }) as
          { error?: unknown } | undefined
        // Only a reported error or an unconfirmed title is a failure: a host that answers with nothing else has accepted it.
        const error = renamed !== null && typeof renamed === 'object' && 'error' in renamed ? renamed.error : undefined
        if (error === undefined && (committed() === undefined || applied(committed()))) return
        if (attempt === 1) this.ctx.logger.warn('dsh-superagent could not title Session %s: %s', agent.id,
          error === undefined ? `the host did not commit "${title}" (it lists "${committed() ?? ''}")` : JSON.stringify(error))
      } catch (error) {
        if (attempt === 1) this.ctx.logger.warn('dsh-superagent could not title Session %s: %s', agent.id, String(error))
      }
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }
  /**
   * The Workspace for a ticket's target directory: the one a person lands in by opening that directory, so a worker's
   * conversation appears where its work does.
   *
   * The registered Workspaces are compared on their canonical form (resolved, separator-normalized, case-insensitive on
   * Windows) because a Workspace keeps the `realpath` it was registered with. An exact match wins; otherwise the deepest
   * registered parent wins, which puts a ticket under a repository root's Workspace instead of one per worktree; only a
   * directory no Workspace contains is registered — the way opening it would register it.
   * @param directory - the ticket's target directory.
   * @returns the existing or newly registered Workspace.
   */
  async workspaceFor(directory: string): Promise<{ id: string; path?: string }> {
    const wanted = await canonicalPath(directory)
    // A host that cannot list its Workspaces still gets this directory registered, exactly as opening it would.
    let listed: readonly { id: string; path?: string }[] = []
    try { listed = [...await this.ctx.workspaceRegistry.list()] } catch { listed = [] }
    return nearestWorkspace(listed, wanted) ?? await this.ctx.workspaceRegistry.create(wanted)
  }
  /** Ensures a worker Session inside the Workspace for `directory`, so the conversation sits where its work is. */
  async ensureWorker(id: string, title: string, directory: string): Promise<Agent> {
    const workspace = await this.workspaceFor(directory)
    return this.ensure(id, title, 'worker', workspace.id)
  }
  /**
   * The Workspace the Router's own conversations belong to: the registered one whose path is the Router's directory.
   *
   * The Router is a conversation about the deployment, not a conversation inside the project, so it gets its own
   * directory rather than `process.cwd()`. Membership is exact — a Workspace only accounts for a Session whose stored
   * `cwd` equals its own `path` — which is why this resolves the exact match instead of the deepest containing one: the
   * project checkout would otherwise claim the Router, because the Router's directory sits inside it nowhere at all.
   * Creating it is the same act as a person opening that directory, and it is idempotent: the registry answers the
   * existing record for a path it already holds.
   */
  /** The Router's own Workspace directory, before it is resolved: what a row's `cwd` is compared with. */
  routerDirectory(): string { return this.host.routerDirectory() }
  async routerWorkspace(): Promise<{ id: string; path?: string } | undefined> {
    const wanted = await canonicalPath(this.host.routerDirectory())
    try { await mkdir(wanted, { recursive: true }) } catch (error) { this.ctx.logger.warn('dsh-superagent could not create the Router workspace directory: %s', String(error)) }
    // An exact path match only: `nearestWorkspace` would hand back a parent and leave the Router accounted elsewhere.
    let exact: { id: string; path?: string } | undefined
    try {
      const listed = [...await this.ctx.workspaceRegistry.list()]
      exact = listed.find(item => item.path !== undefined && samePath(item.path, wanted))
    } catch { /* A host that cannot list still gets the directory registered below. */ }
    const workspace = exact ?? await this.ctx.workspaceRegistry.create(wanted)
    await this.nameRouterWorkspace(workspace.id)
    return workspace
  }
  /**
   * Name the Router's Workspace after the Router, and only when the Workpace still carries its default name.
   *
   * A fresh Workspace is titled after its directory's last segment, which would show the group as `router-workspace`.
   * A title a person chose is left alone, so this is idempotent rather than a rename on every start.
   * @param workspaceId - the Router's Workspace.
   */
  private async nameRouterWorkspace(workspaceId: string): Promise<void> {
    try {
      const entity = this.ctx.workspaceRegistry.get(workspaceId as never) as
        { title?: string; path?: string; setTitle?: (title: string) => Promise<void> } | undefined
      if (entity?.setTitle === undefined) return
      const fallback = entity.path === undefined ? undefined : entity.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop()
      // Renamed only while it still wears the name the registry gave it: a person's own title wins.
      if (entity.title !== undefined && entity.title !== fallback) return
      await entity.setTitle(ROUTER_WORKSPACE_TITLE)
    } catch (error) { this.ctx.logger.warn('dsh-superagent could not title its Router workspace: %s', String(error)) }
  }
  private readonly directLaunches = new Map<string, Promise<{ agent: Agent; from: number; replayed: boolean }>>()

  /** Open a normal conversation without entering the ticket executor or inheriting Router authority. */
  async createDirectWorker(router: Agent, input: { request_id: string; title: string; directory?: string | undefined; text: string }) {
    const directory = input.directory ?? router.session.header.cwd
    if (!directory || !isAbsolute(directory)) throw new Error('Provide an absolute working directory or open the Router in a workspace')
    const request = key(router.id, input.request_id)
    const record = KV.sessions.directWorker(request)
    const signature = key(directory, input.title, input.text)
    const pending = this.directLaunches.get(request)
    if (pending) {
      // Check the durable signature even if a concurrent caller is still resolving the workspace.
      const result = await pending
      if (this.host.store.get(record)?.signature !== signature) throw new Error('This request_id already names a different task')
      return { ...result, replayed: true }
    }
    const launch = async () => {
      let state = this.host.store.get(record)
      if (state && state.signature !== signature) throw new Error('This request_id already names a different task')
      if (!state) {
        // The person names a directory, so a missing one is their mistake to correct: report it as that, not as the
        // native `ENOENT` a bare realpath would throw into the Router's reply.
        const path = await realpath(directory).catch(() => undefined)
        if (path === undefined) throw new Error(`The working directory does not exist: ${directory}`)
        if (!(await stat(path)).isDirectory()) throw new Error(`The working directory is not a directory: ${directory}`)
        const registry = this.ctx.workspaceRegistry
        const workspace = (await registry.list()).find(item => samePath(item.path, path)) ?? await registry.create(path)
        state = { signature, requestedId: `session-${randomUUID()}`, workspaceId: workspace.id }
        this.host.store.set(record, state)
      }
      if (!state.sessionId) {
        // If the process stopped after native creation but before recording the response, recover the original ID
        // instead of asking create() to reuse a now non-blank conversation (which would mint another ID).
        const workspace = this.ctx.workspaceRegistry.get(state.workspaceId as never)
        const requested = state.requestedId as SessionId
        const sessionId = workspace?.sessionIds.includes(requested) ? requested : (await this.ctx.sessionController.create({
          sessionId: requested, workspaceId: state.workspaceId as never, agentPreset: 'standard',
        })).sessionId
        state = { ...state, sessionId }
        this.host.store.set(record, state)
      }
      const resolved = await this.ctx.sessionController.resolveAgent(state.sessionId as SessionId)
      if ('error' in resolved) throw resolved.error
      const agent = resolved.agent
      if (agent.id === router.id || agent.session.header.origin === 'subagent' || agent.session.header.parentSession != null)
        throw new Error('The host did not return an independent worker conversation')
      const from = agent.session.snapshotEvents().length
      const replayed = state.delivered === true
      if (!replayed) {
        await this.name(agent, input.title)
        await this.prompt(agent.id, key('direct-worker-input', request), input.text, 'queue')
        this.host.store.set(record, { ...state, delivered: true })
      }
      return { agent, from, replayed }
    }
    const operation = launch()
    this.directLaunches.set(request, operation)
    try { return await operation } finally { this.directLaunches.delete(request) }
  }

  /** Add only ticket-scoped tools to a borrowed conversation; preserve its existing preset, prompts, and tools. */
  async borrow(agent: Agent, ticket: Ticket): Promise<void> {
    if (this.host.store.tickets.open().some(current => current.id !== ticket.id
      && current.execution?.borrowedSession?.sessionId === agent.id))
      throw new Error('DSH Session already has another open borrowed ticket')
    const existing = this.borrowed.get(agent)
    if (existing?.ticketId === ticket.id) return
    if (existing) {
      const previous = this.host.store.tickets.get(existing.ticketId)
      if (previous && liveTicket(previous)) throw new Error('DSH Session already has a borrowed ticket')
      this.releaseBorrowed(agent)
    }
    const binding: SessionBinding = { disposers: [] }
    const abort = new AbortController()
    this.borrowed.set(agent, { ticketId: ticket.id, disposers: binding.disposers, abort })
    try {
      const register = this.registerTool(agent, binding)
      for (const tool of this.host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, (args, signal) => {
        const current = this.host.store.tickets.get(ticket.id)
        if (abort.signal.aborted || !current || !liveTicket(current) || current.execution?.borrowedSession?.sessionId !== agent.id)
          throw new Error('Borrowed ticket ended or is no longer bound to this Session')
        return tool.execute(args, AbortSignal.any([signal, abort.signal]))
      })
    } catch (error) {
      this.releaseBorrowed(agent)
      throw error
    }
  }
  /**
   * The directory of the Workspace the client actually shows as the default. `initializeDefault` is the host's own answer to
   * that question; the list order is not, because a Workspace created for some other Session can come first.
   */
  async defaultWorkspace(): Promise<{ id: string; path?: string } | undefined> {
    try {
      const preferred = await this.ctx.workspaceRegistry.initializeDefault(async () => process.cwd()).catch(() => undefined)
      if (preferred) return preferred
      const listed = [...await this.ctx.workspaceRegistry.list()]
      return listed.find(item => item.path?.toLowerCase() === process.cwd().toLowerCase()) ?? listed[0]
    } catch { return undefined }
  }
  /** Remove ticket tools when a loan ends without disposing the person's conversation. */
  releaseTicket(ticketId: string): void {
    for (const [agent, loan] of this.borrowed) if (loan.ticketId === ticketId) this.releaseBorrowed(agent)
  }
  private releaseBorrowed(agent: Agent): void {
    const loan = this.borrowed.get(agent)
    if (!loan) return
    this.borrowed.delete(agent)
    loan.abort.abort(new Error('Borrowed ticket ended'))
    for (const dispose of loan.disposers.reverse()) dispose()
  }
  /** Returns whether `sessionId` already holds the message delivered under `requestId`, or `false` if the session does not exist. */
  async holds(sessionId: string, requestId: string): Promise<boolean> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    return !('error' in result) && await this.agentDelivery.holds(result.agent, key(requestId))
  }
  /** Deliver a message once per request id: to the next turn, the current one, or `inject`ed with its label without waking the agent. */
  async prompt(sessionId: string, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const result = await this.ctx.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result) throw result.error
    await this.agentDelivery.send(result.agent, key(requestId), text, mode, this.host.lifetime, authorize, accepted)
  }
  /** The id of the message `prompt` delivers under `requestId`, which DSH's inbox events name it by. */
  promptedId(requestId: string): MessageId { return messageId(key(requestId)) }
  /** Enqueues a steering relay to the main Session; relays are durable and retried by `Effects` until delivered, at most once per `requestId`. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /**
   * Enqueues one message for the Router conversation as an ordinary next turn.
   *
   * Every path that hands the Router something to read — a person typing in the panel, a worker's answer — goes through
   * here, so a stopped Router queues work instead of being woken by it. The queue row is durable and deduplicated by
   * `requestId`, exactly like the other effects; a start releases it in arrival order.
   * @param requestId - idempotency key of this delivery.
   * @param text - the message.
   */
  routerMessage(requestId: string, text: string, sessionId?: string): void {
    this.host.effects.enqueue('relay', requestId, { text, queue: true, ...(sessionId === undefined ? {} : { sessionId }) })
  }
  /** Enqueues a durable background notice for injection into the main Session; a new notice with the same `name` replaces a still-waiting notice of that `name`. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for currently runnable `notice` effects to settle and returns `'injected'` if notice `name` has reached the main Session or `'pending'` if it is still queued. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** Injects a notice into the main Session without waking it; no-op if the main Session does not exist yet. */
  private async inject(name: string, value: Record<string, unknown>, summary: string): Promise<void> {
    const resolved = await this.ctx.sessionController.resolveAgent(this.host.masterId as SessionId)
    if ('error' in resolved) return
    // Deduplicate by notice name and payload hash so retries are idempotent while updated payloads still deliver.
    const text = JSON.stringify(value)
    await this.agentDelivery.send(resolved.agent, `notice:${name}:${key(text)}`, text, { inject: summary }, this.host.lifetime)
  }
  /** Returns the current prompt revision, the active prompt revision of each loaded Session, and whether the main Session still has a pending `'prompts'` notice. */
  status() {
    const { store, prompts, effects } = this.host
    const sessions = store.keys(KV.sessions.prompts).flatMap(name => {
      const sessionId = name.slice(KV.sessions.prompts.prefix.length), revision = store.get(name)?.at(-1)
      return this.ctx.agents.get(sessionId as SessionId) && revision !== undefined ? [{ sessionId, revision }] : []
    })
    return { revision: prompts.current().revision, sessions, notificationPending: effects.pending('notice', 'prompts') }
  }
  /** Returns the prompt version a Session runs under (the one bound on its latest model request, or the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a Session is authorized to read `revision` (its active revision or any revision it previously ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Returns a tool registrar for `agent` that renders tool output as JSON text and attaches `output.image` as an image when present. */
  private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
    return (name, description, schema, execute) => {
      binding.disposers.push(agent.ctx.tools.register({ name, description, parameters: z.toJSONSchema(schema),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
          const text = { type: 'text' as const, text: JSON.stringify(value) }
          const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
          return image ? [text, { type: 'image' as const, attachment: image }] : [text]
        } },
        execute: (args, execution) => execute(schema.parse(args), execution.signal) }))
    }
  }
  /** Returns `sessionId`'s active model-budget retry state (`{ model_retry }`) for status listings, or `{}` when not waiting on one. */
  modelRetry(sessionId: string | undefined) {
    const retry = sessionId ? this.retryHealth.get(sessionId) : undefined
    return retry ? { model_retry: retry } : {}
  }
  private updateModelHealth(): void {
    const retries = this.retryHealth.list()
    this.host.health.set(retries.length
      ? { state: 'error', detail: retries.slice(0, 5).map(item => `${item.sessionId}: ${item.provider} is over its model budget; retried ${item.attempts} times, waiting since ${item.since}; the model and retry policy are unchanged`).join('; ') + (retries.length > 5 ? `; ${retries.length - 5} more Sessions` : ''), at: retries.at(-1)!.lastAt }
      : { state: 'ready', detail: 'No managed Session is waiting on a model budget retry' })
  }
  private ticketOf(agent: Agent): Ticket | undefined {
    const ticketId = ticketOfSession(agent.id)
    return ticketId === undefined ? undefined : this.host.store.tickets.get(ticketId)
  }
  private async decorate(agent: Agent): Promise<void> {
    if (this.bindings.has(agent)) return
    const host = this.host
    const projectRouter = host.managedRouter?.(agent.id)
    // Manually selecting Router in the conversation picker must install dispatch tools and execution guards too.
    const master = agent.id === host.masterId || projectRouter !== undefined || this.routed(agent)
    const ticket = master ? undefined : this.ticketOf(agent)
    if (!master && !ticket) { this.limitSubagent(agent); return }
    const binding: SessionBinding = { disposers: [] }
    this.bindings.set(agent, binding)
    this.retryHealth.restore(agent.id, agent.session.snapshotEvents())
    if (agent.status === 'idle') this.retryHealth.clear(agent.id)
    this.updateModelHealth()
    // Disable variable interpolation so literal ${{ ... }} expressions in team prompts are preserved.
    binding.disposers.push(agent.ctx.systemPrompt.section({ name: 'dsh-superagent-policy', order: 9999, interpolate: false, text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const current = ticket && host.store.tickets.get(ticket.id)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      // A project Router is told which project it serves and the latest durable state; it must read a receipt before writing.
      const project = projectRouter === undefined ? undefined : host.managedRouter?.(agent.id)
      const projectNote = project === undefined ? '' :
        `\n\n[project ${project.projectId}]\nBefore this project operation, call the knowledge read of Router ${agent.id} and use its receipt; if it answers a conflict, read again. Latest durable project state (not original conversation text):\n${project.summary || '(empty)'}`
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}${projectNote}`
    }, ...(master ? { complete: true } : {}) }))
    // A recreated skill scope (e.g. after the skills service restarts) starts empty, so reset `binding.skills` before rebinding.
    const skillScope = agent.ctx.inject(['skills'], scope => {
      binding.scope = scope
      binding.skills = undefined
      this.bindSkills(binding, host.prompts.current())
    })
    binding.disposers.push(() => { skillScope.dispose().catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release a skill scope: %s', String(error)) }) })
    await skillScope
    // Bail out if the agent was disposed while awaiting the skill scope.
    if (this.bindings.get(agent) !== binding) return
    const register = this.registerTool(agent, binding)
    const toolset = host.tools(agent, ticket)
    for (const tool of toolset) register(tool.name, tool.description, tool.schema, tool.execute)
    if (master) {
      // The Router denies the profile's own tools and the preset's own tools, and keeps `ROUTER_TOOLS` plus its own
      // `orchestrator_*` registrations. Everything a mounted module contributes sits ABOVE the preset generation, so it is
      // inherited and visible without being named here — which is the fix: a deny-list cannot go stale when a module is
      // mounted or swapped, and `dsh-module-layer` emits no `tools/change` to recompute an allow-list on.
      //
      // Every name here came from this scope's own view, so `restrict` — which validates names against exactly that view —
      // accepts the whole list.
      binding.disposers.push(agent.ctx.tools.restrict({ deny: routerDeniedTools(agent.ctx.tools, agent) }),
        agent.ctx.tools.guard(execution => {
          // A managed Router's authority can be revoked by a committed refresh while this Agent object is still alive.
          if (projectRouter !== undefined && host.managedRouterAllowed?.(agent.id) === false)
            return 'This Router Session has been replaced by a refresh; continue in the new Session'
          // Delegation is refused by execution, not by the allow-list: `restrict` cannot mask a scope-registered tool,
          // and a Router that spawns children works outside the ticket pipeline this plugin exists to keep.
          if ((ROUTER_FORBIDDEN as readonly string[]).includes(execution.name)) return ROUTE_NOT_DELEGATE
          return noWait(execution, () => this.routed(agent))
        }))
    } else {
      // An Executor Session keeps the profile's work tools it has, which DSH requires to be known; its own tools are not masked.
      binding.disposers.push(...this.workOnly(agent, ticket!.id))
    }
  }
  /**
   * Whether this Session currently routes. Asked at decoration time (to decide whether it gets dispatch tools) and by the
   * wait guard (to decide whether the router preset's short waits apply).
   *
   * The durable header counts first, because a person who picked Router before the first message has that preset recorded
   * at creation while the registry or projection may not answer yet — reading only the registry left such a Session with
   * just `read`, `skill` and `read_image`, a Router that could not dispatch. A registry that DOES answer still wins: a
   * Session switched away from the router preset must not keep its caps, which is what the "switched" tests pin down.
   */
  private routed(agent: Agent): boolean {
    try {
      // Inside the guard: an Agent built without a durable session (a host fixture, or one mid-construction) has no
      // header at all, and this predicate must answer rather than throw.
      const recorded = agent.session.header?.agentPreset
      const presets = this.ctx.get('agentPresets') as { presetForSession?: (session: Agent['session']) => string | null } | undefined
      const projections = this.ctx.get('sessionProjections') as { stateOf?: (session: Agent['session'], key: string) => unknown } | undefined
      const selected = typeof presets?.presetForSession === 'function' ? presets.presetForSession(agent.session)
        : projections?.stateOf?.(agent.session, 'agentPreset')
      // Only a concrete answer overrides the header; "no answer" falls back to what the Session was created with.
      if (selected === undefined || selected === null) return recorded === ROUTER_PRESET
      return selected === ROUTER_PRESET
    } catch { return false }
  }
  /**
   * An Executor Session's tools: only the profile's work tools, which DSH requires to be known, and none once its ticket
   * ended. A failed or blocked worker keeps its tools, so a person may continue it in its Session; only automated input waits
   * (see the executor). Read inherited tools through the parent scope, which includes the preset's tools. The global view
   * misses preset tools; the agent's own view also includes local tools such as subagent, which restrict refuses to name.
   */
  private workOnly(agent: Agent, ticketId: string): (() => void)[] {
    const store = this.host.store
    const parent = scopeParentOf(agent)
    const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
    return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
      const current = store.tickets.get(ticketId)
      return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
    })]
  }
  /**
   * A subagent of an Executor Session, or of one of its subagents, which runs under DSH's `standard` preset with the worker's
   * permissions, gets the same work tools as the worker, and none once the worker's ticket ended. Any other agent is left as
   * it is.
   */
  private limitSubagent(agent: Agent): void {
    // A Session built without a durable log has no header, so there is no parent to walk: nothing to limit.
    let parent = agent.session.header?.parentSession
    // Up the subagents' parents to the worker, which are loaded while their subagents run.
    for (let depth = 0; parent !== undefined && ticketOfSession(parent) === undefined && depth < 8; depth++) {
      parent = this.ctx.agents.get(parent)?.session.header?.parentSession
    }
    const ticketId = parent === undefined ? undefined : ticketOfSession(parent)
    if (ticketId === undefined || !this.host.store.tickets.get(ticketId)) return
    this.bindings.set(agent, { disposers: this.workOnly(agent, ticketId), subagent: true })
  }
  /** Register the skills of a prompt version in the agent's skill scope, in place of an earlier version's. */
  private bindSkills(binding: SessionBinding, version: PromptVersion): void {
    const { scope, skills: previous } = binding
    if (!scope || previous?.revision === version.revision) return
    previous?.dispose()
    const disposers: (() => void)[] = []
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom dsh-superagent operational skill.')
      disposers.push(scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime',
        ...(bundled ? { resourceBase: { kind: 'directory' as const, path: dirname(bundled.path) } } : {}) }))
    }
    binding.skills = { revision: version.revision, dispose: () => { disposers.forEach(dispose => dispose()) } }
  }
  /** Return the current prompt version, updating the agent's skills and recording the revision in Store when bound to a model request. */
  private promptFor(agent: Agent, bind: boolean): PromptVersion {
    const version = this.host.prompts.current()
    if (!bind) return version
    const binding = this.bindings.get(agent)
    if (binding) this.bindSkills(binding, version)
    const { store } = this.host
    const revisions = store.get(KV.sessions.prompts(agent.id)) ?? []
    const bound = [...revisions.filter(revision => revision !== version.revision), version.revision]
    if (revisions.at(-1) !== version.revision) store.set(KV.sessions.prompts(agent.id), bound)
    return version
  }
  /** Releases registrations for `agent` in reverse order (LIFO); disposing its skill scope releases its skills as well. */
  private release(agent: Agent): void {
    const binding = this.bindings.get(agent)
    if (!binding) return
    this.bindings.delete(agent)
    binding.skills?.dispose()
    for (const dispose of binding.disposers.splice(0).reverse()) {
      try { dispose() } catch (error) { this.ctx.logger.warn('dsh-superagent could not release what it registered for a Session: %s', String(error)) }
    }
  }
  /** Releases prompt sections, skills, and tools registered by `Sessions` across all decorated agents. */
  dispose(): void {
    for (const agent of [...this.borrowed.keys()]) this.releaseBorrowed(agent)
    for (const agent of [...this.bindings.keys()]) this.release(agent)
  }
}
