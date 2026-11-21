/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-api-session-controller'
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
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
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
import { Prompts } from './prompts.ts'
import { registerHttp, registerLockWaitHttp, type HttpHost } from './http.ts'
import { Control, routerStopped, sessionRoot } from './control.ts'
import { acquireStateLock, describeLock, lockPath, type LockAttempt, type LockPolicy, type LockRefusal } from './state-lock.ts'
import { selectRouterSessions } from './router-sessions.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
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
/** Resolves a DSH session read within a couple of seconds, or fails loudly instead of leaving the panel loading forever. */
async function bounded<T>(read: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer in time; retry once the running turn ends`)), 3000)
  })
  try { return await Promise.race([read, timeout]) } finally { clearTimeout(timer) }
}
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
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  /** The lock that could not be taken, when another process holds this machine's state directory. */
  readonly lockWait?: LockRefusal
  masterId!: string
  private readonly sourceLinks = new TextCache(200_000)
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
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      // The router's own conversation must be a DSH-catalogued Session, or the workspace cannot open it: `session-<uuid>`.
      // An installation from before this rule keeps its stored id only when it already has that form; otherwise it gets a new one.
      const stored = store.get(KV.runtime.masterId)
      const catalogued = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      const masterId = this.masterId = stored && catalogued.test(stored) ? stored : `session-${randomUUID()}`
      store.set(KV.runtime.masterId, masterId)
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
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        lifetime: this.lifetime,
        closing: () => this.closing(), routerStopped: () => routerStopped(store),
        environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.holds(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'steer'), candidateCard: candidate => candidateCard(links, candidate) })
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
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        health: this.runtimeHealth, lifetime: this.lifetime, ready: () => setup.ready(), closing: () => this.closing() })
      // The operator's control over the Router conversation: the stop/start switch, its audit trail, and deletions of the
      // conversations this plugin owns. It reads the switch from the store on every delivery, so a stop takes effect on the
      // next handoff and a start releases what the stop held.
      this.control = new Control({ context: ctx, store, masterId, requestPass: () => { passes.request() },
        sessionRoot: () => sessionRoot(ctx) })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
      get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        control: this.control,
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
   * Makes the Router's own conversation openable from the panel: it must belong to a Workspace the client knows (the
   * process working directory, not the plugin's state directory), and a Session with no message is hidden from the list,
   * so it gets one opening message, injected without waking the model.
   */
  private async ensureRouterSession(): Promise<void> {
    try {
      // The conversation must live in a Workspace the client already shows, or opening it reports the Session as unusable.
      // `ensure` names only that Workspace: DSH takes the directory from `workspace.path`.
      const workspace = await this.sessions.defaultWorkspace()
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
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks,
      control: this.control,
      // DSH's session calls queue behind a running turn; a bounded read keeps the panel from showing an endless spinner.
      listDshSessions: async () => bounded(this.ctx.sessionController.list({}, new AbortController().signal).then(listed => listed.items), 'the DSH session list'),
      /** The router conversation's last exchanges, so the panel can show it as the permanent chat it is. */
      routerChat: async (limit: number) => {
        // DSH puts a message's blocks at `data.content`; an assistant reply may also arrive under `data.message`.
        type Blocks = readonly { type?: string; text?: string }[]
        type Shown = { type?: string; data?: { content?: Blocks; message?: { content?: Blocks }; name?: string; arguments?: string } }
        const [events, listed] = await Promise.all([
          bounded(runtime.ctx.sessionController.inspect(runtime.masterId as SessionId).then(found => found.events as readonly Shown[]), 'the router transcript'),
          bounded(runtime.ctx.sessionController.list({}, new AbortController().signal).then(found => found.items), 'the DSH session list'),
        ])
        const textOf = (blocks: Blocks | undefined): string =>
          (blocks ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('\n').trim()
        // A worker dispatch is a `orchestrator_worker_message` tool call; it is shown under the reply that requested it.
        const titles = new Map<string, string>()
        for (const session of listed) {
          const titled = session as typeof session & { title?: string; projectionValues?: { title?: string } }
          const title = titled.title ?? titled.projectionValues?.title
          if (title) titles.set(session.sessionId, title)
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
       */
      routerSessions: async () => {
        const stored = await bounded(runtime.ctx.sessionPersistence.list(), 'the stored Session headers')
        const listed = await bounded(runtime.ctx.sessionController.list({}, new AbortController().signal)
          .then(found => found.items), 'the DSH session list').catch(() => [])
        return { masterId: runtime.masterId,
          items: selectRouterSessions(stored.map(snapshot => snapshot.header), listed, runtime.masterId) }
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
