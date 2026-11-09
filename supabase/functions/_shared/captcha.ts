// CAPTCHA verification for public forms (Cloudflare Turnstile). Pure and injectable so it is tested offline.
// Real verification posts the token to Turnstile's siteverify endpoint with EF_CAPTCHA_SECRET_KEY. A deterministic mock exists
// for LOCAL stacks only: it is chosen when EF_CAPTCHA_SECRET_KEY is exactly "local-mock" AND the function runs against a local
// Supabase URL; it accepts the token "mock-ok" and nothing else. Without a usable configuration every check fails closed.

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const LOCAL_MOCK_SECRET = "local-mock";
export const LOCAL_MOCK_TOKEN = "mock-ok";

export type CaptchaResult = { ok: true } | { ok: false; reason: "missing" | "rejected" | "unavailable" };
export interface CaptchaVerifier { readonly id: "turnstile" | "mock" | "unconfigured"; verify(token: unknown, remoteIp?: string | null): Promise<CaptchaResult> }

/** True for a Supabase URL served from this machine or the local Docker network (never a hosted project). */
export function isLocalSupabaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "kong" || host === "host.docker.internal" || host.endsWith(".local");
  } catch { return false; }
}

export function createTurnstileVerifier(options: { secret: string; fetch?: typeof fetch; timeoutMs?: number }): CaptchaVerifier {
  const doFetch = options.fetch ?? fetch;
  return {
    id: "turnstile",
    async verify(token, remoteIp) {
      if (typeof token !== "string" || !token.trim() || token.length > 2048) return { ok: false, reason: "missing" };
      const form = new URLSearchParams({ secret: options.secret, response: token });
      if (remoteIp) form.set("remoteip", remoteIp);
      try {
        const res = await doFetch(TURNSTILE_VERIFY_URL, { method: "POST", body: form, signal: AbortSignal.timeout(options.timeoutMs ?? 8000) });
        if (!res.ok) return { ok: false, reason: "unavailable" };
        const body = (await res.json()) as { success?: boolean };
        return body.success === true ? { ok: true } : { ok: false, reason: "rejected" };
      } catch { return { ok: false, reason: "unavailable" }; }
    },
  };
}

export function createMockCaptchaVerifier(): CaptchaVerifier {
  return {
    id: "mock",
    verify(token) {
      if (typeof token !== "string" || !token) return Promise.resolve({ ok: false, reason: "missing" });
      return Promise.resolve(token === LOCAL_MOCK_TOKEN ? { ok: true } : { ok: false, reason: "rejected" });
    },
  };
}

/** Picks the verifier from the environment. The mock is never used against a hosted Supabase URL. */
export function selectCaptchaVerifier(config: { EF_CAPTCHA_SECRET_KEY?: string; SUPABASE_URL?: string }, options: { fetch?: typeof fetch } = {}): CaptchaVerifier {
  const secret = (config.EF_CAPTCHA_SECRET_KEY ?? "").trim();
  if (secret === LOCAL_MOCK_SECRET) {
    if (isLocalSupabaseUrl(config.SUPABASE_URL ?? "")) return createMockCaptchaVerifier();
  } else if (secret) {
    return createTurnstileVerifier({ secret, fetch: options.fetch });
  }
  return { id: "unconfigured", verify: () => Promise.resolve({ ok: false, reason: "unavailable" }) };
}
