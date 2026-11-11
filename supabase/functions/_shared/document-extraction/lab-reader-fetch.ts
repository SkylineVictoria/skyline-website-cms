// LAB ONLY: EF_OPENAI_API_URL sends the document reader's OpenAI calls to the lab's mock reader, and only when SUPABASE_URL is a local
// Supabase; on any other project (hosted) the plain fetch is returned and the variable is ignored. Shared by staff-onboarding and
// validated-document-upload (the student upload function of PR #29), so both read the lab's `%lab-category:` files the same way.
import { isLocalSupabaseUrl } from "../captcha.ts";

const OPENAI_ORIGIN = "https://api.openai.com";

export function readerFetch(env: Record<string, string | undefined>, doFetch: typeof fetch = fetch): typeof fetch {
  const base = (env.EF_OPENAI_API_URL ?? "").trim().replace(/\/+$/, "");
  if (!base || !isLocalSupabaseUrl(env.SUPABASE_URL ?? "")) return doFetch;
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    return doFetch(url.startsWith(`${OPENAI_ORIGIN}/`) ? base + url.slice(OPENAI_ORIGIN.length) : url, init);
  }) as typeof fetch;
}
