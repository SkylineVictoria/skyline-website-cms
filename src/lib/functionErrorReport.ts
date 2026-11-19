/**
 * Edge Function errors people see (2026-11-20): every 5xx answer (546 included) the browser gets from /functions/v1/<name> is reported to
 * public.edge_function_error_report, which the daily health check reads (Needs action today > Scheduled jobs or Edge Functions failing).
 * Never throws, never blocks the caller, never reports its own report, and sends one report per function and status per minute per tab.
 */
const FUNCTION_PATH = /\/functions\/v1\/([a-z0-9-]{2,48})(?:[/?#]|$)/;

/** The function a request URL calls, or null when it is not an Edge Function call. */
export function functionNameOf(url: string): string | null {
  return FUNCTION_PATH.exec(url)?.[1] ?? null;
}

/** 5xx only (a 4xx is the caller's mistake, and 546 is the platform's resource limit). */
export const isServerError = (status: number) => Number.isInteger(status) && status >= 500 && status <= 599;

/** The error text sent: one line, no e-mail addresses, long numbers or token-like strings, at most 200 characters (the database cleans it again). */
export function cleanErrorText(text: string): string {
  return Array.from(String(text ?? ""), (ch) => { const code = ch.charCodeAt(0); return code < 32 || code === 127 ? " " : ch; }).join("")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/[A-Za-z0-9_-]{24,}|[0-9][0-9 ]{7,}[0-9]/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

const lastSent = new Map<string, number>();

export interface ReportTarget { supabaseUrl: string; apikey: string; authorization?: string | null; fetchImpl?: typeof fetch; now?: () => number }

/** Sends one report (fire and forget). Returns whether it was sent (false: not a server error, not a function, or sent within the last minute). */
export function reportFunctionError(name: string | null, status: number, errorText: string, target: ReportTarget): boolean {
  try {
    if (!name || !isServerError(status) || !target.supabaseUrl || !target.apikey) return false;
    const now = (target.now ?? Date.now)();
    const key = `${name}:${status}`;
    if (now - (lastSent.get(key) ?? -Infinity) < 60_000) return false;
    lastSent.set(key, now);
    const send = target.fetchImpl ?? globalThis.fetch.bind(globalThis);
    void send(`${target.supabaseUrl.replace(/\/+$/, "")}/rest/v1/rpc/edge_function_error_report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: target.apikey, Authorization: target.authorization || `Bearer ${target.apikey}` },
      body: JSON.stringify({ p_function: name, p_status: status, p_error: cleanErrorText(errorText) }),
      keepalive: true,
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

/** For a fetch wrapper: reports the answer when it is a 5xx from an Edge Function (reads a copy of the body, up to 200 characters). */
export function reportIfFunctionFailed(url: string, response: Response, target: ReportTarget): void {
  const name = functionNameOf(url);
  if (!name || !isServerError(response.status)) return;
  void response.clone().text().then((text) => reportFunctionError(name, response.status, text.slice(0, 2000), target), () => reportFunctionError(name, response.status, "", target));
}

/** Test hook: forget which reports were sent. */
export function resetFunctionErrorReports(): void { lastSent.clear(); }
