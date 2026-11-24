/**
 * A Router's tool boundary must hide the profile's own tools and the preset's own tools, while leaving a mounted
 * module's tools visible — and it must stay correct when the mounted module changes.
 *
 * Runs against the REAL `@deepseek-ai/dsh-tools` registry and `@deepseek-ai/dsh-scope` keys, because the behaviour under
 * test is exactly the interaction between the two: a module registers into its own scope layer, the preset generation
 * binds under it, the Session binds under that, and `restrict` masks everything the Session inherits. A stub registry
 * cannot express that, so this builds the chain the way `dsh-module-layer` and the preset registry do.
 */
import { Context } from '@deepseek-ai/cordis'
import { ToolRuntime, defineTool } from '@deepseek-ai/dsh-tools'
import { bindScopeParent, createScope, scopeOf, type ScopeParentBinding, type ScopeKey } from '@deepseek-ai/dsh-scope'
import { expect, it } from 'vitest'
import { routerDeniedToolsForTest } from '../src/app/sessions.ts'

const ROUTER_TOOLS = ['skill', 'read', 'read_image']
const PROFILE_TOOLS = ['write', 'edit', 'pwsh', 'bash', 'glob', 'grep', 'web_search', 'todo_write']

/** A defined scope key; `scopeOf` is declared optional but a `createScope` result always has one. */
const keyOf = (ctx: Context): ScopeKey => scopeOf(ctx) as ScopeKey

/** One tool definition with the shape `defineTool` requires (a parameter DSL plus a JSON-Schema output). */
const tool = (name: string) => defineTool({
  name,
  description: `test tool ${name}`,
  parameters: { note: { type: 'string' as const } },
  output: { schema: { type: 'object' as const, properties: {}, additionalProperties: false }, render: () => [{ type: 'text' as const, text: name }] },
  execute: async () => ({}),
})

/**
 * Build the real scope chain `[session, generation, module]`.
 * The profile's wide tools are global; the preset's own tools (including a shell and a delegation entry) sit in the
 * generation layer; the module's tools sit in the module layer; superagent's own tools sit in the session layer.
 */
function chain(moduleTools: string[]) {
  const root = new Context()
  root.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, getSectionOrder: () => 0 })
  const tools = new ToolRuntime(root, { mode: 'native' })
  for (const name of PROFILE_TOOLS) tools.register(tool(name))

  const moduleScope = createScope(root, { kind: 'module', id: 'test-module' })
  for (const name of moduleTools) moduleScope.ctx.tools.register(tool(name))

  const generationScope = createScope(root, {})
  for (const name of [...ROUTER_TOOLS, 'bash', 'spawn_teammate']) generationScope.ctx.tools.register(tool(name))

  const sessionScope = createScope(root, {})
  const own = ['orchestrator_read', 'orchestrator_route']
  for (const name of own) sessionScope.ctx.tools.register(tool(name))

  const binding: ScopeParentBinding = bindScopeParent(keyOf(generationScope.ctx), keyOf(moduleScope.ctx))
  bindScopeParent(keyOf(sessionScope.ctx), keyOf(generationScope.ctx))
  return { root, tools, moduleScope, sessionScope, binding, key: keyOf(sessionScope.ctx), own }
}

/** What the Session actually sees once the Router's deny list is installed. */
function visibleWithRouterBoundary(scope: { tools: ToolRuntime; sessionScope: { ctx: Context }; key: ScopeKey }) {
  const deny = routerDeniedToolsForTest(scope.tools, scope.key)
  const lift = scope.sessionScope.ctx.tools.restrict({ deny })
  const visible = scope.tools.schemas(scope.key).map(schema => schema.name).sort()
  lift()
  return { deny, visible }
}

it('leaves a mounted module’s tools visible and hides the profile’s own tools', () => {
  const scope = chain(['ctf_scan_binary', 'ctf_dump'])
  const { deny, visible } = visibleWithRouterBoundary(scope)
  expect(visible).toEqual(expect.arrayContaining(['ctf_scan_binary', 'ctf_dump']))
  expect(visible).toEqual(expect.arrayContaining([...ROUTER_TOOLS, ...scope.own]))
  // The whole profile surface stays out, and so does the preset's own shell and delegation entry.
  expect(visible).not.toContain('write')
  expect(visible).not.toContain('pwsh')
  expect(visible).not.toContain('bash')
  expect(visible).not.toContain('spawn_teammate')
  // The deny list names only those, never the tools the Router keeps.
  expect(deny).toEqual(expect.arrayContaining(['write', 'pwsh', 'bash', 'spawn_teammate']))
  expect(deny).not.toContain('read')
  expect(deny).not.toContain('ctf_scan_binary')
})

it('needs no recomputation to follow a module swap, because it never names a module tool', async () => {
  const scope = chain(['ctf_scan_binary'])
  const denyBefore = routerDeniedToolsForTest(scope.tools, scope.key)
  expect(denyBefore).not.toContain('ctf_scan_binary')
  expect(visibleWithRouterBoundary(scope).visible).toContain('ctf_scan_binary')

  // Swap the mounted module: dispose it, bind another generation key above the preset, give it its own tool.
  await scope.moduleScope.dispose()
  const next = createScope(scope.root, { kind: 'module', id: 'next-module' })
  scope.binding.rebind(keyOf(next.ctx))
  next.ctx.tools.register(tool('forensics_timeline'))

  // Same deny list, computed once: the new module's tool is visible and the old one's is gone. An allow-list naming
  // module tools could not do this — `dsh-module-layer` emits no `tools/change` to trigger a recompute.
  expect(routerDeniedToolsForTest(scope.tools, scope.key)).toEqual(denyBefore)
  const after = visibleWithRouterBoundary(scope)
  expect(after.visible).toContain('forensics_timeline')
  expect(after.visible).not.toContain('ctf_scan_binary')
  expect(after.visible).not.toContain('bash')
})

it('keeps the Router to the same surface when no module is mounted at all', () => {
  const scope = chain([])
  const { visible } = visibleWithRouterBoundary(scope)
  expect(visible).toEqual([...ROUTER_TOOLS, ...scope.own].sort())
})

it('denies nothing extra when the registry cannot project schemas, so the Session still composes', () => {
  const scope = chain(['ctf_scan_binary'])
  // A host double without `schemas`: the derivation must degrade to the old surface rather than throw during decoration.
  expect(routerDeniedToolsForTest({} as typeof scope.tools, scope.key)).toEqual([])
})

it('leaves out the reserved PTC transport, which `restrict` refuses to name at all', () => {
  // Under PTC mode `run_code` is part of the global view this derivation reads, and naming it in ANY restriction throws
  // ("cannot name reserved PTC mode presentation transport"), which would leave the Router undecorated.
  const scope = chain(['ctf_scan_binary'])
  const deny = routerDeniedToolsForTest(scope.tools, scope.key)
  expect(deny).not.toContain('run_code')
  // The whole list must also be nameable: `restrict` validates against this scope's own inheritable surface.
  const restrictable = (scope.tools as unknown as { view(key: ScopeKey): { restrictableNames: Set<string> } })
    .view(scope.key).restrictableNames
  expect(deny.filter(name => !restrictable.has(name))).toEqual([])
  expect(() => scope.sessionScope.ctx.tools.restrict({ deny })).not.toThrow()
})
