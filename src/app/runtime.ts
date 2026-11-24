/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sameDirectory } from '../infra/environment.ts'
import { Engine, key, reasonText, type DomainEvent, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { FailureLog } from './failures.ts'
import { StreamHub, type StreamTopic } from './stream.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, registerLockWaitHttp, registerStream, type HttpHost } from './http.ts'
import { ProjectKnowledge } from './project-knowledge.ts'
import { RouterRegistry } from './router-registry.ts'
import { RouterSessionHost, refreshRouterSession, type RouterSessionIo } from './router-session-host.ts'
import { TaskboardReader, taskboardDatabase } from './tasks.ts'
import { Control, routerStopped, sessionRoot } from './control.ts'
import { acquireStateLock, describeLock, lockPath, type LockAttempt, type LockPolicy, type LockRefusal } from './state-lock.ts'
import { selectRouterSessions, sessionTitle } from './router-sessions.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { Patrol, PATROL_DEFAULTS } from './patrol.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()
/**
 * Which refetch a domain event asks the panel for, or `undefined` for one no open view shows.
 *
 * The map is deliberately small and explicit: a topic is a route the panel already has, and publishing one it does not
 * listen to would only be noise. Triggers, Decisions and Threads all land in Overview and the Thread list, which the
 * panel refetches together.
 */
function streamTopicOf(event: DomainEvent): StreamTopic | undefined {
  switch (event.type) {
    case 'ticket.created': case 'ticket.resumed': case 'ticket.ended':
    case 'assignment.started': case 'assignment.ended': return 'tickets'
    case 'trigger.received': case 'decision.recorded': case 'eval.started':
    case 'thread.subscribed': case 'thread.unsubscribed':
    case 'trigger.requeued': case 'trigger.followup': return 'overview'
    case 'policy.changed': return 'settings'
    default: return undefined
  }
}
/**
 * The domain events that can change what the patrol would report.
 *
 * A ticket appearing, ending, or resuming changes its row; an assignment ending changes who is running.
 * Nothing else does: a trigger arriving, an eval starting, a decision being recorded and a subscription
 * moving all leave the patrol's four inputs alone, so asking it to look would only cost a scan.
 */
const PATROL_EVENTS = new Set<DomainEvent['type']>(['ticket.created', 'ticket.resumed', 'ticket.ended', 'assignment.started', 'assignment.ended'])
/** Resolves a DSH session read within a couple of seconds, or fails loudly instead of leaving the panel loading forever. */
async function bounded<T>(read: Promise<T>, what: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in time; retry once the running turn ends`)), ms)
  })
  try { return await Promise.race([read, timeout]) } finally { clearTimeout(timer) }
}
/**
 * How long the stored-Session-header snapshot may take before the route answers its last good snapshot instead.
 *
 * `sessionPersistence.list()` reads the first frame of every stored log — 233 files and 164 MB on this machine — so it is
 * a whole-corpus scan, not a metadata lookup, and it queues behind whatever else the host is doing. The panel polls it
 * every 4 s; a scan that misses the deadline used to answer 500, and the client then hid nothing and said the Router rows
 * were unreadable. The deadline is generous on purpose: a snapshot that arrives is worth far more than a fast failure.
 */
const ROUTER_SNAPSHOT_MS = 20_000
/**
 * How long a header snapshot stays usable for the next poll.
 *
 * The set of Router conversations changes only when one is created, refreshed or deleted, so re-reading the whole corpus
 * on every poll is pure cost. Two seconds keeps the group live (a poll is 4 s) while collapsing the panel's own poll and
 * any overlapping reader onto one scan.
 */
const ROUTER_SNAPSHOT_TTL_MS = 2000
/**
 * How long the DSH session-list snapshot stays usable, and how long one read of it may take.
 *
 * `sessionController.list()` is the cheaper of the two reads (the host walks its own query index rather than every log
 * file), but it still yields between records and queues behind a running turn, so three routes asking for it in the same
 * poll each paid for a full pass. One shared read per poll is enough for titles and recency; the TTL is shorter than the
 * panel's 4 s poll so each poll still sees fresh data.
 */
const DSH_LIST_TTL_MS = 2000
const DSH_LIST_MS = 15_000
/** The router Session's first message: it makes the conversation visible in the workspace without waking the model. */
const ROUTER_GREETING = '这是 dsh-superagent 的常驻 Router 对话。直接说「列出所有 worker」看它在指挥哪些对话，或说「让 <对话标题> 去做 <事情>」把指令发给某个 worker。'
/** Its sidebar title: fixed, so the permanent conversation is recognizable and does not take a title from its first message. */
const ROUTER_TITLE = 'Router（常驻）'
/** Why nothing that needs the database can answer while another process holds the state directory. */
const lockWaitError = (directory: string): Error =>
  new Error(`dsh-superagent is waiting for the state directory lock ${lockPath(directory)}; another process holds it`)
/** The holder's trace as a log line: a lock directory's last refresh is all another process can see of its holder. */
function holderText(refusal: LockRefusal): string {
  const { holder } = refusal
  if (!holder) return 'no lock directory was there'
  const age = holder.ageMs === undefined ? 'at an unknown time' : `${(holder.ageMs / 1000).toFixed(1)} s ago`
  return `its lock directory was last refreshed ${age}${holder.refreshedAt ? `, at ${holder.refreshedAt}` : ''}`
}
/** The `runtime` health entry of a state directory this process could not lock: another process holds it, or it cannot be used at all. */
function lockHealth(refusal: LockRefusal, directory: string): Health {
  const held = (refusal.error as NodeJS.ErrnoException).code === 'ELOCKED'
  const age = refusal.holder?.ageMs
  const values = { path: lockPath(directory), age: age === undefined ? 'unknown' : `${(age / 1000).toFixed(1)} s`,
    error: refusal.error.message.split('\n')[0] ?? refusal.error.message }
  return { ...health(held ? 'starting' : 'error', held ? 'lockWait' : 'lockError', values), at: now() }
}
/** Creates the state directory and takes its lock, reporting a directory that cannot be created like a lock that is held. */
function stateLock(directory: string, policy: Partial<LockPolicy>, onCompromised: (error: Error) => void): LockAttempt {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return acquireStateLock(directory, { ...policy, onCompromised })
  } catch (error) {
    const holder = describeLock(directory)
    return { refusal: { error: error instanceof Error ? error : new Error(String(error)), attempts: 0, waitedMs: 0, ...holder ? { holder } : {} } }
  }
}
/**
 * The context a Source kind gets while another process holds the state directory: its kind registers its health entries,
 * and nothing is read, written or polled, so the Source's plugin entry stays mounted and quiet.
 */
function waitingContext(directory: string): SourceContext {
  const missing = (): never => { throw lockWaitError(directory) }
  return {
    get deployment() { return missing() },
    commands: new Commands(missing, {}, AbortSignal.abort()),
    ready: Promise.resolve(),
    configured: () => false,
    config: () => undefined,
    receive: missing,
    atomic: missing,
    state: { get: missing, set: missing, keys: missing },
    threads: { get: missing, subscribed: missing, describe: missing, patch: missing },
    tickets: { get: missing, open: missing, bindThread: missing, threadClosed: missing },
    triggers: { get: missing, latest: missing },
    notify: () => {},
    report: () => {},
  }
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state; a lock
 * another process holds leaves the parts below unbuilt and the Runtime reporting `lockWait` instead of failing to mount.
 */
export class Runtime extends Service implements SourceHost {
  // Built once this process holds the state directory. They stay unset while another process holds it (`lockWait` below),
  // which is why every entry point that can run in that state answers the wait rather than reaching for them.
  readonly store!: Store
  readonly setup!: Setup
  readonly prompts!: Prompts
  readonly effects!: Effects
  readonly sources!: SourceRegistry
  readonly commands!: Commands
  readonly sessions!: Sessions
  readonly settings!: Settings
  readonly executor!: DshExecutor
  readonly assessor!: MasterAssessor
  readonly outbox!: Outbox
  readonly engine!: Engine
  readonly passes!: Passes
  readonly control!: Control
  /**
   * The silent patrol: it reads the tickets this process already stores and tells the Router, once, about
   * a problem it has not been told about. Nothing about it is a second source of truth — the findings are
   * derived from `Store` on every tick, and the only thing it keeps is the set it last reported.
   */
  readonly patrol!: Patrol
  /**
   * The managed-Router binding and its project knowledge. Neither exists before the database is open: a host waiting for
   * another process's state directory lock has no store to bind into, and the three managed routes answer 503 there.
   */
  readonly knowledge?: ProjectKnowledge
  readonly routers?: RouterRegistry
  /**
   * The DSH Session boundary an archive-before-refresh runs through: hold admission, export the complete flushed log,
   * create a replacement without waking it, verify it, and summarize the archive. Optional for the same reason as the
   * registry: it does no work until the database that records the binding exists.
   */
  readonly routerHost?: RouterSessionHost
  /**
   * The Router panel's task list, read out of the Taskboard plugin's store. Built even while another process holds
   * the state directory: it needs no state of its own, and the panel then keeps its list instead of losing it.
   */
  readonly tasks: TaskboardReader
  /** The panel's live channel: every change a person can see is announced here instead of being polled for. */
  readonly stream = new StreamHub()
  /**
   * The bounded log of failures a fixed code path recorded, and the one place a failure becomes a Router message.
   * Set once the database is open; a host waiting for another process's lock has no log to write.
   */
  readonly failures!: FailureLog
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  /** The lock that could not be taken, when another process holds this machine's state directory. */
  readonly lockWait?: LockRefusal
  private initialMasterId!: string
  get masterId(): string {
    return this.routers?.successorOf(this.initialMasterId)?.sessionId ?? this.initialMasterId
  }
  private readonly sourceLinks = new TextCache(200_000)
  /**
   * The last complete stored-Session-header snapshot the Router group was served from, and the scan still in flight.
   *
   * One scan feeds every reader: the panel polls the route, and a poll that arrives while a scan runs waits for that scan
   * instead of starting a second one over the same corpus. A scan that fails leaves the previous snapshot in place, so a
   * transient host hiccup degrades the rows' recency instead of emptying the group.
   */
  private routerHeaders?: { readonly at: number; readonly headers: readonly SessionHeader[] }
  private routerHeadersScan?: Promise<readonly SessionHeader[]>
  /**
   * The last DSH session list, shared by every route that needs it, and the read still in flight.
   *
   * Separate from the header snapshot: the two reads come from different authorities (durable log headers vs the host's
   * live catalog) and one may succeed while the other queues. A failed refresh keeps the previous list, so a busy host
   * degrades recency instead of emptying a panel.
   */
  private dshList?: { readonly at: number; readonly items: readonly SessionSummary[] }
  private dshListRead?: Promise<readonly SessionSummary[]>
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps!: SourceContextDeps
  private readonly toolHost!: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  /**
   * @param lockPolicy - the lock's stale window and attempts; a start waits about ten seconds by default, which covers
   *   the lock directory a killed predecessor leaves behind without holding up the host's own boot.
   */
  constructor(ctx: Context, readonly machine: Machine, restart: () => void, lockPolicy: Partial<LockPolicy> = {}) {
    super(ctx, 'orchestrator')
    const runtime = this
    // The Taskboard plugin's store is resolved on every refresh, so a board that the operator moves or that starts
    // late is picked up without restarting this plugin; nothing here reads or writes dsh-superagent's own state.
    // The service is unwrapped as `unknown` because this package has no dependency on the Taskboard package.
    const taskboard = () => (ctx as unknown as { get(name: string): unknown }).get('taskboard')
    this.tasks = new TaskboardReader(() => taskboardDatabase({
      service: taskboard() as { config?: { databasePath?: unknown } } | undefined }))
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    // A predecessor killed a moment ago still holds its lock directory for the stale window, so the attempts wait it out:
    // giving up here used to throw out of the constructor, which left the plugin unmounted, every route 404, and the
    // panel saying dsh-superagent did not respond.
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    const attempt = stateLock(machine.stateDir, lockPolicy, compromised)
    if (!attempt.held) {
      const refusal = attempt.refusal!
      this.lockWait = refusal
      this.runtimeHealth.set(lockHealth(refusal, machine.stateDir))
      ctx.logger.error('dsh-superagent could not lock its state directory %s after %d attempt(s) and %d ms: %s; %s',
        lockPath(machine.stateDir), refusal.attempts, refusal.waitedMs, refusal.error.message, holderText(refusal))
      // Sources inject `orchestrator` and register their kinds as they mount; an inert registry keeps those entries
      // mounted, and their polls stop at `configured() === false` instead of reaching for a database that is not open.
      this.sources = new SourceRegistry(() => { throw lockWaitError(machine.stateDir) })
      this.ready = this.serveLockWait()
      return
    }
    const held = attempt.held
    this.releaseLock = held.release
    if (held.attempts > 1) ctx.logger.warn('dsh-superagent waited %d attempt(s) and %d ms for the state directory lock',
      held.attempts, held.waitedMs)
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      // Project knowledge and the managed-Router registry share the one Store transaction boundary: a receipt is minted
      // and consumed inside `store.atomic`, so an operation cannot commit against a snapshot that moved underneath it.
      const knowledge = this.knowledge = new ProjectKnowledge(store)
      const routers = this.routers = new RouterRegistry(store, knowledge)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      // The router's own conversation must be a DSH-catalogued Session, or the workspace cannot open it: `session-<uuid>`.
      // An installation from before this rule keeps its stored id only when it already has that form; otherwise it gets a new one.
      const stored = store.get(KV.runtime.masterId)
      const catalogued = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      this.initialMasterId = stored && catalogued.test(stored) ? stored : `session-${randomUUID()}`
      store.set(KV.runtime.masterId, this.initialMasterId)
      // The Session boundary behind an archive-before-refresh. Built here, after the identity it reads is known, and
      // before any route can ask it for one: a refresh that ran earlier would have no Router conversation to archive.
      const routerHost = this.routerHost = new RouterSessionHost({
        sessions: {
          resolveAgent: async sessionId => {
            const resolved = await ctx.sessionController.resolveAgent(sessionId as SessionId)
            return 'error' in resolved ? { error: resolved.error } : { agent: resolved.agent }
          },
          // An export must not resume a cold Session: composing an Agent only to replace it would run setup for nothing.
          liveAgent: sessionId => ctx.agents.get(sessionId as SessionId),
          inspect: async sessionId => await ctx.sessionController.inspect(sessionId as SessionId),
          create: async request => await ctx.sessionController.create({ sessionId: request.sessionId as SessionId,
            workspaceId: request.workspaceId as never, agentPreset: request.agentPreset }),
        } satisfies RouterSessionIo,
        // DSH's own durability entry point: THE flush (the checkpoint policy uses it too), never a raw `session/flush`.
        flush: session => ctx.sessions.flush(session as never),
        persistence: { flush: () => ctx.sessionPersistence.flush(),
          stat: async sessionId => await ctx.sessionPersistence.stat(sessionId as SessionId) },
        /**
         * The replacement joins the Workspace the Session it replaces runs in, found from that Session's own header
         * rather than from the process directory: a deployment whose Router sits elsewhere must not stage its new
         * generation in a folder the person never opened. The Workspace is created for that directory when none covers
         * it, exactly as opening the directory would; a replaced Session with no `cwd` refuses instead of guessing.
         */
        workspace: async replacing => {
          // `workspaceRegistry.list()` is synchronous (an in-memory table), so a failure here is a real refusal rather
          // than a promise rejection; the try keeps an unavailable registry from breaking the refresh path silently.
          let listed: readonly { readonly id: string; readonly path: string }[] = []
          try { listed = ctx.workspaceRegistry.list() } catch { listed = [] }
          const directory = ctx.agents.get(replacing as SessionId)?.session.header.cwd
          if (directory === undefined) return undefined
          return listed.find(item => sameDirectory(item.path, directory)) ?? await ctx.workspaceRegistry.create(directory)
        },
        logger: { warn: (message, ...args) => ctx.logger.warn(message, ...args) },
      })
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId: this.masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId: this.masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), routerStopped: () => routerStopped(store),
        // A managed (project) Router is decorated like the master one, but its authority comes from the registry rather
        // than from the startup-captured id: a refresh replaces the Session, and the old one must lose its tools.
        managedRouter: sessionId => {
          const bound = routers.list().find(identity => identity.sessionId === sessionId)
          return bound === undefined ? undefined : { projectId: bound.projectId, summary: knowledge.snapshot(bound.projectId).summary }
        },
        // Rechecked at execution time: a committed refresh makes the superseded Session's generation stale, and this is
        // what stops it from acting on the project afterwards.
        managedRouterAllowed: sessionId => routers.list().some(identity => identity.sessionId === sessionId),
        environment,
        // Beside the state directory and outside the project's checkout: the Router talks about the deployment, so its
        // conversation is not one of the deployment's own source-tree conversations.
        routerDirectory: () => join(machine.stateDir, 'router-workspace'),
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      // The failure log exists before the executor, which records into it, and pushes each record to every open panel.
      const stream = this.stream
      this.failures = new FailureLog({ store, routerMessage: (id, text) => { sessions.routerMessage(id, text) },
        publish: record => { stream.publish('failures', record) } })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.holds(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger), failures: this.failures,
        stream: topic => { stream.publish(topic) } })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(this.masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => executor.prepare(ticket, outcome), emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended) store.afterCommit(() => sessions.releaseTicket(ended.id))
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
          // The panel's live channel: every domain event is a change a person can see, so each is announced once it
          // commits. A rolled-back transaction announces nothing, which is why this waits for `afterCommit`.
          const topic = streamTopicOf(event)
          if (topic) store.afterCommit(() => { stream.publish(topic) })
          // What the patrol watches moved: a ticket appeared, ended, resumed, or one of its assignments
          // ended. Its own thresholds cover time; these are the changes a clock cannot predict.
          if (PATROL_EVENTS.has(event.type)) store.afterCommit(() => { runtime.patrol?.request() })
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, ready: () => setup.ready(), closing: () => this.closing() })
      // The silent patrol. It owns no timer of its own beyond the one it arms for the next threshold, and it
      // never polls the model: `request()` is the only thing that can make it look sooner, so the domain
      // events below are what keep it current between thresholds.
      const patrol = this.patrol = new Patrol({ store, effects, health: board.claim('patrol', { state: 'ready', detail: 'Nothing to report' }),
        stopped: () => routerStopped(store), closing: () => this.closing() }, PATROL_DEFAULTS)
      // The operator's control over the Router conversation: the stop/start switch, its audit trail, and deletions of the
      // conversations this plugin owns. It reads the switch from the store on every delivery, so a stop takes effect on the
      // next handoff and a start releases what the stop held.
      this.control = new Control({ context: ctx, store, masterId: () => this.masterId, routers,
        ownsWorker: id => store.tickets.list().some(ticket => workerSessionId(ticket.id) === id)
          || store.keys(KV.sessions.directWorker).some(name => store.get(name as ReturnType<typeof KV.sessions.directWorker>)?.sessionId === id),
        requestPass: () => { passes.request() },
        sessionRoot: () => sessionRoot(ctx) })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
      get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        control: this.control,
        // A worker's own failed/blocked report enters the failure log in the same transaction as the report itself.
        get failures() { return runtime.failures },
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        titleOf: async (sessionId: string) => {
          // The title is committed as a `session/title` event; the list projection may leave it out, so read the history.
          type Titled = { type?: string; data?: { title?: string } }
          const events = (await runtime.ctx.sessionController.inspect(sessionId as SessionId)).events as readonly Titled[]
          return events.filter(event => event.type === 'session/title').at(-1)?.data?.title ?? ''
        },
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { held.releaseSync() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext {
    return this.lockWait ? waitingContext(this.machine.stateDir) : sourceContextOf(this.sourceDeps, kind)
  }
  /** Resolved deployment; throws while waiting for setup (`!configured()`), or for another process's state directory lock. */
  get deployment(): Deployment { return this.needs(this.setup).deployment }
  configured(): boolean { return this.setup?.configured() ?? false }
  get setupProblem(): SetupProblem | undefined { return this.setup?.problem }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup?.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup?.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket), setup = this.needs(this.setup)
    // Only an enabled Source reads the Deployment for its values, and a sourceless deployment resolved none: they stay absent.
    const deployment = setup.configured() ? setup.deployment : undefined
    return ticketEnvironment({ deployment, sources: this.needs(this.sources), settings: this.store.settings(), ticket,
      ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup?.check() }
  receive(trigger: Trigger): ReceiveResult { return this.needs(this.passes).receive(trigger) }
  idle(): Promise<void> { return this.needs(this.passes).idle() }
  pump(): Promise<void> { return this.needs(this.passes).pump() }
  sendReplies(): Promise<void> { return this.needs(this.outbox).sent() }
  /** One of the parts the state directory's lock gates, or the wait's error while another process holds it. */
  private needs<T>(part: T | undefined): T {
    if (part === undefined) throw lockWaitError(this.machine.stateDir)
    return part
  }
  private closing(): boolean { return this.closingFlag }
  /**
   * The stored Session headers, from a snapshot that is shared, reused and never thrown away by a failed read.
   *
   * `sessionPersistence.list()` scans the whole log corpus, so the Router group must not make every poll pay for it: a
   * snapshot younger than {@link ROUTER_SNAPSHOT_TTL_MS} is reused, an in-flight scan is joined rather than duplicated,
   * and a scan that misses {@link ROUTER_SNAPSHOT_MS} answers the previous snapshot when there is one. Only a first-ever
   * read that times out fails, and that failure is reported as a failure — the client must never read it as "the Router
   * has no conversations", because an empty list silently stops it hiding the duplicate rows.
   */
  private async routerHeaderSnapshot(): Promise<readonly SessionHeader[]> {
    const cached = this.routerHeaders
    if (cached !== undefined && Date.now() - cached.at < ROUTER_SNAPSHOT_TTL_MS) return cached.headers
    const scan = this.routerHeadersScan ??= (async () => {
      try {
        const stored = await bounded(this.ctx.sessionPersistence.list(), 'the stored Session headers', ROUTER_SNAPSHOT_MS)
        const headers = stored.map(snapshot => snapshot.header)
        this.routerHeaders = { at: Date.now(), headers }
        return headers
      } finally { this.routerHeadersScan = undefined }
    })()
    try {
      return await scan
    } catch (error) {
      // A stale snapshot beats no answer: the group keeps showing the conversations it last saw, and the next poll retries.
      if (cached !== undefined) {
        this.ctx.logger.warn('dsh-superagent served the previous Router snapshot: %s', String(error))
        return cached.headers
      }
      throw error
    }
  }
  /**
   * The DSH session list, from one shared snapshot per poll instead of one full pass per caller.
   *
   * The Router panel asks three routes that all need this list (the group's rows, the panel's own list, and the Router
   * chat's dispatch titles), so on a busy host each of them used to queue behind the host separately and each could time
   * out on its own. Reuse is safe because the list is only ever read for titles and recency: the authority for what a
   * conversation *is* stays the durable header in {@link routerHeaderSnapshot}.
   */
  private async dshSessionList(): Promise<readonly SessionSummary[]> {
    const cached = this.dshList
    if (cached !== undefined && Date.now() - cached.at < DSH_LIST_TTL_MS) return cached.items
    const read = this.dshListRead ??= (async () => {
      try {
        const items = await bounded(this.ctx.sessionController.list({}, new AbortController().signal)
          .then(listed => listed.items), 'the DSH session list', DSH_LIST_MS)
        this.dshList = { at: Date.now(), items }
        return items
      } finally { this.dshListRead = undefined }
    })()
    try {
      return await read
    } catch (error) {
      // As with the headers: a stale list beats no list, and the next poll retries rather than the route answering 500.
      if (cached !== undefined) {
        this.ctx.logger.warn('dsh-superagent served the previous DSH session list: %s', String(error))
        return cached.items
      }
      throw error
    }
  }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  /**
   * Hold launches and input deliveries: while a person paused processing, or before setup has finished.
   * A sourceless deployment has finished (`Setup.ready`) although no Deployment resolved: it has no Source to poll, so
   * nothing opens a Ticket on its own, but a person can still hand it one and its workers execute it. A Deployment that
   * failed to resolve is not ready, so an installation whose required account settings are missing starts no worker.
   */
  private holds(): boolean { return !this.setup?.ready() || this.store.settings().paused }
  /**
   * Makes the Router's own conversation openable from the panel: it must belong to a Workspace the client knows, and a
   * Session with no message is hidden from the list, so it gets one opening message, injected without waking the model.
   *
   * The Workspace is the Router's own directory rather than the process working directory. A Workspace accounts for a
   * Session only when the Session's stored `cwd` equals the Workspace `path`, so a Router created in `process.cwd()` is
   * accounted to the deployment's checkout — which is exactly what put the Router's row among the project's own
   * conversations and forced the client to hide it with an injected rule instead of listing it where it belongs.
   */
  private async ensureRouterSession(): Promise<void> {
    try {
      // Falls back to the default Workspace only when the Router's own directory cannot be registered at all: a Router
      // accounted somewhere is still openable, which beats a conversation the panel cannot reach.
      const own = await this.sessions.routerWorkspace().catch(error => {
        this.ctx.logger.warn('dsh-superagent could not register its Router workspace: %s', String(error))
        return undefined
      })
      const workspace = own ?? await this.sessions.defaultWorkspace()
      await this.sessions.ensure(this.masterId, ROUTER_TITLE, 'orchestrator', workspace?.id)
      if (this.store.get(KV.runtime.greeted) !== this.masterId) {
        // Queued, not injected: a Session whose only message waits for a turn is still a draft the client cannot open, and
        // this one message is what turns the conversation into a real, listed Session with its own hello.
        await this.sessions.prompt(this.masterId, key('router-greeting'), ROUTER_GREETING, 'queue')
        this.store.set(KV.runtime.greeted, this.masterId)
      }
      // Renamed last, so the explicit title is the newest title event: it names the conversation in the sidebar and pins it
      // against the automatic title its first message would otherwise give it.
      const renamed = await this.ctx.sessionController.rename({ sessionId: this.masterId as SessionId, title: ROUTER_TITLE })
      if ('error' in renamed) this.ctx.logger.warn('dsh-superagent could not title its router conversation: %s', String(renamed.error))
    } catch (error) { this.ctx.logger.warn('dsh-superagent could not prepare its router conversation: %s', String(error)) }
  }
  /**
   * Serves the management API while another process holds the state directory. The plugin stays mounted and every route
   * answers the wait with the `runtime` health entry, so the panel says why it is stopped instead of showing the 404s of
   * routes that were never registered.
   */
  private async serveLockWait(): Promise<void> {
    const refusal = this.lockWait
    if (!refusal) return
    this.disposers.push(registerLockWaitHttp(this.ctx, { refusal, machine: this.machine, health: () => this.health }))
  }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    // The live channel is its own route: a host that refuses it (or a test's web-server double) loses only push
    // updates, and the panel falls back to its manual refresh instead of the plugin failing to mount.
    try { this.disposers.push(registerStream(this.ctx, this)) }
    catch (error) { this.ctx.logger.warn('dsh-superagent could not register its change stream: %s', String(error)) }
    // The Taskboard provider publishes after its own committed writes. Follow its Cordis service lifetime.
    const subscription = this.ctx.inject(['taskboard'], child => {
      const service = (child as unknown as { get(name: string): unknown }).get('taskboard') as
        { provider?: { subscribe(listener: () => void): () => void } } | undefined
      const changed = () => { this.tasks.invalidate(); this.stream.publish('tasks') }
      changed()
      const release = service?.provider?.subscribe(changed)
      return () => { release?.(); changed() }
    })
    this.disposers.push(() => { void subscription.dispose() })
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      // The Router conversation is the panel's way in, so it exists even while setup blocks dispatch.
      await this.ensureRouterSession()
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.ensureRouterSession()
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    this.effects.start()
    // Last: the patrol delivers through the effect queue, and a notice queued before the queue starts would
    // wait there until something else kicked it. Its own first tick is what establishes the baseline, so a
    // restart re-derives the same set and says nothing.
    this.patrol.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, ready, sourceLinks, setup, passes } = this
    // `masterId` is read through a getter: a committed refresh moves the main Router to a new generation, and every
    // route that names the Router must follow it rather than the identity this process captured at startup.
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, ready, sourceLinks,
      get masterId() { return runtime.masterId },
      control: this.control, tasks: this.tasks, stream: this.stream,
      // Read through getters on the runtime, not on this object: neither service exists until the database is open,
      // which a host awaiting another process's lock never reaches.
      get managed() {
        const registry = runtime.routers, knowledge = runtime.knowledge, host = runtime.routerHost
        if (!registry || !knowledge) return undefined
        return { registry, knowledge,
          // Absent (not failing) when the boundary was never built: the route then answers that refresh is unavailable
          // instead of pretending the Router has no history to archive.
          ...host ? { refresh: (routerId: string, sessionId: string, generation: number) =>
            refreshRouterSession({ registry, host, routerId, sessionId, generation }) } : {} }
      },
      // Read through a getter on the runtime, not on this object: the log is built once the database is open, which a
      // host awaiting another process's lock never reaches.
      get failures() { return runtime.failures },
      // DSH's session calls queue behind a running turn; a bounded read keeps the panel from showing an endless spinner.
      listDshSessions: async () => runtime.dshSessionList(),
      /** The router conversation's last exchanges, so the panel can show it as the permanent chat it is. */
      routerChat: async (limit: number) => {
        // DSH puts a message's blocks at `data.content`; an assistant reply may also arrive under `data.message`.
        type Blocks = readonly { type?: string; text?: string }[]
        type Shown = { type?: string; data?: { content?: Blocks; message?: { content?: Blocks }; name?: string; arguments?: string } }
        const events = await bounded(runtime.ctx.sessionController.inspect(runtime.masterId as SessionId)
          .then(found => found.events as readonly Shown[]), 'the router transcript', DSH_LIST_MS)
        // Titles only decorate a dispatch line, so a list the host would not answer leaves the replies intact rather than
        // failing the whole transcript: the shared snapshot supplies it, and a cold failure degrades to no titles.
        const listed = await runtime.dshSessionList().catch(() => [] as readonly SessionSummary[])
        const textOf = (blocks: Blocks | undefined): string =>
          (blocks ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
        // A worker dispatch is a `orchestrator_worker_message` tool call; it is shown under the reply that requested it.
        const titles = new Map<string, string>()
        for (const session of listed) {
          // `sessionTitle` reads all three seats DSH has used for a title; reading only the first two left every
          // dispatched line blank for rows whose title lives under `projections.values.title`.
          const title = sessionTitle(session as never)
          const id = (session as { sessionId?: string }).sessionId
          if (title && id) titles.set(id, title)
        }
        const items: { role: 'user' | 'assistant'; text: string; dispatched: string[] }[] = []
        // Injected background notices (time context, runtime reminders) are not things the person said.
        const injected = (event: Shown): boolean => {
          const source = (event.data as { source?: { kind?: string } } | undefined)?.source
          return source?.kind !== undefined && source.kind !== 'user'
        }
        for (const event of events) {
          if (event.type === 'user/message' || event.type === 'assistant/message') {
            if (event.type === 'user/message' && injected(event)) continue
            const text = textOf(event.data?.content) || textOf(event.data?.message?.content)
            if (text) items.push({ role: event.type === 'user/message' ? 'user' : 'assistant', text, dispatched: [] })
            continue
          }
          if (event.type !== 'tool/call' || event.data?.name !== 'orchestrator_worker_message') continue
          const target = items.findLast(item => item.role === 'assistant')
          if (!target) continue
          try {
            const args = JSON.parse(event.data.arguments ?? '{}') as { session?: string }
            const title = args.session ? titles.get(args.session) ?? '' : ''
            if (title && !target.dispatched.includes(title)) target.dispatched.push(title)
          } catch { /* A malformed argument list shows no dispatch; the reply still renders. */ }
        }
        return { sessionId: runtime.masterId, items: items.slice(-limit) }
      },
      /**
       * The virtual Router workspace's rows. Durable Session headers decide membership: the `agentPreset` projection
       * reads `standard` for the shipped 常驻 conversation although its header says `dsh-superagent-router`. The host
       * list supplies only titles and recency, so a slow list degrades the rows instead of failing the whole group.
       *
       * The headers come from a shared snapshot (see `routerHeaderSnapshot`): the panel polls this route, and a
       * whole-corpus scan per poll is what used to answer 500 and leave the group hiding nothing.
       */
      routerSessions: async () => {
        const headers = await runtime.routerHeaderSnapshot()
        // A cold failure of the list must not empty the group: the headers alone still decide membership, so the rows
        // render with no title instead of the client hiding nothing.
        const listed = await runtime.dshSessionList().catch(() => [] as readonly SessionSummary[])
        // The Router's own directory tells the client which rows the sidebar already lists at home, so it only has to
        // hide the duplicates of the ones that still live in a project Workspace.
        return { masterId: runtime.masterId,
          items: selectRouterSessions(headers, listed, runtime.masterId, runtime.sessions.routerDirectory()) }
      },
      /** Delivery shapes of the router transcript, so the panel and its tests can rely on the fields DSH really emits. */
      routerEventTypes: async () => {
        const events = (await runtime.ctx.sessionController.inspect(runtime.masterId as SessionId)).events as readonly { type?: string; data?: unknown }[]
        const counts = new Map<string, number>()
        for (const event of events) counts.set(event.type ?? '?', (counts.get(event.type ?? '?') ?? 0) + 1)
        return { counts: [...counts].map(([type, count]) => ({ type, count })) }
      },
      /** One transcript event of a kind, verbatim, for aligning the chat view with the host's real payloads. */
      routerEventSample: async (type: string) => {
        const events = (await runtime.ctx.sessionController.inspect(runtime.masterId as SessionId)).events as readonly { type?: string; data?: unknown }[]
        const found = events.find(event => event.type === type)
        return { found: found ? JSON.stringify(found).slice(0, 1200) : null }
      },
      /** Delivers one message into the router conversation; its reply arrives as the conversation runs. A stopped Router
       * holds it in the durable queue instead of waking, and a start hands it over in arrival order. */
      routerSend: async text => {
        runtime.sessions.routerMessage(key('router-chat', String(Date.now()), text), text)
        return { sent: true as const, ...(runtime.control.stopped ? { queued: true as const } : {}) }
      },
      // `get` returns undefined when no Plugin Market is mounted; a property access would throw without an injection.
      get pluginMarket() { return runtime.ctx.get('pluginMarket') as HttpHost['pluginMarket'] | undefined },
      sourceless: () => setup.sourceless,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => this.ctx.sessionController.modelCatalog() }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true
    // Waiting for another process's state directory: nothing was opened, so only the wait's routes unmount.
    if (this.lockWait) { for (const dispose of this.disposers.reverse()) dispose(); return }
    const passes = this.needs(this.passes).stop(); this.stopped.abort()
    try {
      // The patrol's timer goes first and a tick in flight is waited for: it writes the store and closes
      // nothing itself, but a tick still running while the database closed underneath it would throw.
      await this.patrol?.dispose()
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      // Last, after the routes are unmounted: an open stream holds the listener open, so it ends before the host closes it.
      this.stream.dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
