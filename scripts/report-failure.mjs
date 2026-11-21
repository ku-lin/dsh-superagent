#!/usr/bin/env node
/**
 * Report a worker or ticket failure to dsh-superagent without a model in the loop.
 *
 * This is the out-of-process half of the failure tool: a wrapper script, a supervisor, a CI step, or a person at a
 * shell that saw a worker die calls this and the failure enters the same log the executor writes to, and the same
 * Router queue. Nothing is inferred and nothing is summarized by a model — the string given to `--detail` is what the
 * Router reads.
 *
 * The route it calls is the management API's `POST worker/failure`, which is same-origin fenced: the request carries
 * `x-orchestrator-request: 1` and omits the session cookie, exactly as the panel's own writes do. No credential is
 * needed beyond being able to reach the loopback port.
 *
 * Usage:
 *   node scripts/report-failure.mjs --ticket <id> --session <id> --kind crash --detail "..." [--exit-code 3]
 *   node scripts/report-failure.mjs --detail "a worker died" --url http://127.0.0.1:3082
 *
 * Exit codes: 0 recorded (or deliberately suppressed as a duplicate), 1 the host refused or was unreachable,
 * 2 the arguments were wrong. `--json` prints the host's answer verbatim.
 */

import { parseArgs } from 'node:util'

const KINDS = ['crash', 'turn-error', 'agent-error', 'report-failed', 'timeout', 'exit', 'launch']
/** The default management port of a DSH host running dsh-superagent, matching `scripts/dsh-superagent`. */
const DEFAULT_URL = process.env['DSH_SUPERAGENT_URL'] || 'http://127.0.0.1:3082'
/** A report is one short paragraph; a longer one is a log file the caller should keep itself. */
const DETAIL_LIMIT = 4000

const usage = (message) => {
  process.stderr.write(`report-failure: ${message}\n\n`
    + 'Usage: node scripts/report-failure.mjs --detail <text> [--ticket <id>] [--session <id>]\n'
    + `       [--kind ${KINDS.join('|')}] [--exit-code <n>] [--url <http://127.0.0.1:port>] [--json]\n`)
}

const { values } = (() => {
  try {
    return parseArgs({ strict: true, allowPositionals: false, options: {
      detail: { type: 'string' },
      ticket: { type: 'string' },
      session: { type: 'string' },
      kind: { type: 'string', default: 'crash' },
      'exit-code': { type: 'string' },
      url: { type: 'string', default: DEFAULT_URL },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false, short: 'h' },
    } })
  } catch (error) {
    usage(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
})()

if (values.help) { usage('help'); process.exit(0) }

const detail = (values.detail ?? '').trim()
if (!detail) { usage('--detail is required: say what went wrong in one line'); process.exit(2) }
if (detail.length > DETAIL_LIMIT) { usage(`--detail is at most ${DETAIL_LIMIT} characters`); process.exit(2) }
if (!KINDS.includes(values.kind)) { usage(`--kind must be one of ${KINDS.join(', ')}`); process.exit(2) }

let exitCode
if (values['exit-code'] !== undefined) {
  exitCode = Number(values['exit-code'])
  if (!Number.isInteger(exitCode)) { usage('--exit-code must be an integer'); process.exit(2) }
}

// Every optional field is omitted rather than sent as null: the host's schema is strict, and an absent ticket is a
// real case (a process that died before it knew which ticket it belonged to).
const body = { kind: values.kind, detail, ...values.ticket ? { ticket: values.ticket } : {},
  ...values.session ? { session: values.session } : {}, ...exitCode === undefined ? {} : { exitCode } }
const endpoint = new URL('/orchestrator/api/worker/failure', values.url).toString()

let response
try {
  response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(body),
    // Bounded: a supervisor reporting a crash must not hang on an unreachable host.
    signal: AbortSignal.timeout(8000), credentials: 'omit',
    headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' } })
} catch (error) {
  process.stderr.write(`report-failure: ${values.url} did not answer: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

const text = await response.text()
let answer
try { answer = text ? JSON.parse(text) : {} } catch { answer = { raw: text } }
if (values.json) process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`)

if (!response.ok) {
  process.stderr.write(`report-failure: the host refused the report (HTTP ${response.status}): ${answer.error ?? text}\n`)
  process.exit(1)
}
if (answer.duplicate) {
  process.stdout.write('report-failure: a failure of this ticket, session and kind was already reported within '
    + '60 seconds; this report was suppressed.\n')
  process.exit(0)
}
const id = answer.failure?.id ?? 'unknown'
process.stdout.write(`report-failure: recorded ${id}${answer.failure?.ticketId ? ` for ${answer.failure.ticketId}` : ''}`
  + ` (${answer.failure?.kind ?? values.kind}); the Router has been told.\n`)
