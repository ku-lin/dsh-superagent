/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
// `sessions` is injected because the Router refresh flushes one Session's log before archiving it; without the
// declaration the service is not reachable on `ctx` and the flush throws "cannot get property without inject".
export const inject = ['agents', 'sessions', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets', 'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Volatile limits update in place without a restart; account changes restart dsh-superagent. DSH's settings service stops
  // serving this entry while dsh-superagent restarts and rereads it only on a configuration write, so trigger `describe()`
  // after restart to keep open configuration forms editable without a page reload.
  // TODO: drop the read once DSH's settings service rereads an entry whose plugin becomes active again.
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() }).catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  // app/context-relief.ts is intentionally NOT installed: it drops the oldest span without archiving it, which loses
  // decisions permanently and violates the Router contract that archiving must succeed before context is replaced.
  // Router context reduction goes through app/router-refresh.ts instead; a future deterministic relief must archive
  // the dropped span into the project knowledge base first.
  await runtime.ready
  // A state directory another process holds keeps the plugin mounted and its routes answering; the panel reports the wait.
  ctx.logger.info(runtime.lockWait ? 'dsh-superagent is waiting for the state directory lock of another process; the panel reports the wait'
    : runtime.configured() ? 'dsh-superagent ready; the Superagent sidebar entry opens the management panel'
      // A deployment with no Source at all is ready too: nothing polls, and a Ticket a person hands it still runs.
      : runtime.setup?.sourceless ? 'dsh-superagent ready without a Source: the Router and its workers run, and nothing polls for work'
        : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
