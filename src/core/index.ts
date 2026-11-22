/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { key } from './ids.ts'
// Claims: a ticket declares what it will write, so two workers cannot quietly edit the same file.
export {
  CONFLICT_HINT,
  claimHit,
  conflictsWith,
  denyText,
  displayPath,
  fsConflict,
  normalizeClaims,
  overlaps,
  under,
  type Claim,
} from './claims.ts'
// Patrol: a set of findings keyed by a stable id, so an unchanged set costs nothing.
export {
  findings,
  reportedMap,
  signatureOf,
  tick,
  type Finding,
  type PatrolInput,
  type PatrolOptions,
  type TickResult,
} from './patrol.ts'
