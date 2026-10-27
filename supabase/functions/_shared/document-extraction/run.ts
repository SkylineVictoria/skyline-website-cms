// Provider-neutral orchestration of one leased extraction job. It owns the
// operation-id lifecycle and the retry/dead-letter policy; persistence is a port,
// so the same code runs against the Edge worker's fenced SQL and against the
// in-memory queue used by tests. Every write is fenced by the job lease inside
// the port, so a stale or cancelled worker can never publish a result.
import { buildExtractionEnvelope, type DocumentExtractionProvider, type ExtractionRequest } from "./contract.ts";

export const MAX_ATTEMPTS = 3;

/** An accepted operation can still finish after these faults; every other failure makes the stored id useless. */
const KEEP_OPERATION_CODES = new Set(["timeout", "network", "rate_limit"]);

export interface JobPort {
  /** The operation recorded for this job, if any. Never throws on absence. */
  loadOperation(): Promise<{ engine: string; operationId: string } | null>;
  /** Records (or, with null, clears) the in-flight operation. False when the lease is no longer held. */
  recordOperation(engine: string, operationId: string | null): Promise<boolean>;
  /** Atomic fenced completion. False when the lease was lost or the job was cancelled; throws on a database error. */
  finish(extraction: unknown, responseId: string | null, usage: Record<string, unknown>): Promise<boolean>;
  /** Fenced failure record. False when the lease was lost; throws on a database error. */
  fail(code: string, message: string, retry: boolean, delaySeconds: number): Promise<boolean>;
}

export type RunResult =
  | { kind: "processed" }
  | { kind: "stale" }
  | { kind: "failure"; code: string; message: string; retryable: boolean };

export function retryPlan(attempts: number, retryable: boolean, random: () => number = Math.random) {
  return { retry: retryable && attempts < MAX_ATTEMPTS, delay: Math.min(900, 30 * 2 ** attempts) + Math.floor(random() * 20) };
}

export async function settleFailure(port: JobPort, attempts: number, code: string, message: string, retryable: boolean) {
  const { retry, delay } = retryPlan(attempts, retryable);
  return { accepted: await port.fail(code, message, retry, delay), retrying: retry };
}

export async function runLeasedExtraction(
  provider: DocumentExtractionProvider,
  request: Omit<ExtractionRequest, "resumeOperationId" | "onOperationAccepted">,
  port: JobPort,
): Promise<RunResult> {
  // Only an operation accepted by this same provider may be resumed; after a provider switch the id is ignored and a fresh submission replaces it.
  let saved: Awaited<ReturnType<JobPort["loadOperation"]>> = null;
  try { saved = await port.loadOperation(); } catch { /* an unreadable receipt only costs a repeat analysis */ }
  const resumeOperationId = saved && saved.engine === provider.id ? saved.operationId : undefined;
  const outcome = await provider.extract({
    ...request,
    ...(resumeOperationId ? { resumeOperationId } : {}),
    onOperationAccepted: async (operationId) => { await port.recordOperation(provider.id, operationId); },
  });
  if (!outcome.ok) {
    if (!KEEP_OPERATION_CODES.has(outcome.code)) { try { await port.recordOperation(provider.id, null); } catch { /* the terminal state clears it too */ } }
    return { kind: "failure", code: outcome.code, message: outcome.message, retryable: outcome.retryable };
  }
  // A wrong category can be retained as an auditable outcome but can never populate an application.
  const extraction = buildExtractionEnvelope(provider, outcome, new Date().toISOString());
  let accepted: boolean;
  try { accepted = await port.finish(extraction, outcome.operationId, outcome.usage); }
  catch { return { kind: "failure", code: "persistence", message: "Extraction completion needs retry/review.", retryable: true }; }
  return accepted ? { kind: "processed" } : { kind: "stale" };
}
