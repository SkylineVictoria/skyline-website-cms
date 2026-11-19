import { createClient } from "@supabase/supabase-js";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { reportFunctionError, reportIfFunctionFailed } from "@/lib/functionErrorReport";

/**
 * Single shared Supabase client for the whole app (singleton).
 * Reads the project URL + anon key that the platform injects into .env.
 */
const supabaseUrl = import.meta.env.VITE_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_PUBLIC_SUPABASE_ANON_KEY as string;

if (!supabaseUrl || !supabaseAnonKey) {
  // Surfaced in the console only; the UI shows a friendly error state instead.
  console.error("Supabase environment variables are missing. Please reconnect the backend.");
}

/** Reports an Edge Function 5xx seen outside the shared client (raw fetch / XHR callers), as an anonymous or signed-in reporter. */
export function reportFunctionFailure(name: string, status: number, errorText: string, authorization?: string | null): void {
  reportFunctionError(name, status, errorText, { supabaseUrl, apikey: supabaseAnonKey, authorization });
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const domain = requestWebsiteDomain();
      // Derive the selector from location, never query strings, localStorage or
      // caller-supplied IDs. RLS separately verifies tenant membership on writes.
      headers.delete("x-tenant-domain");
      if (domain) headers.set("x-tenant-domain", domain);
      const response = await fetch(input, { ...init, headers });
      // An Edge Function that answered 5xx / 546 is reported for the daily health check (2026-11-20), as the same signed-in person.
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      reportIfFunctionFailed(url, response, { supabaseUrl, apikey: supabaseAnonKey, authorization: headers.get("Authorization") });
      return response;
    },
  },
  auth: {
    // Stay signed in until an explicit Log out: the session is kept in localStorage (the default) and renewed with the refresh
    // token, however long the app was closed. No time-box or inactivity limit is applied here; any such limit is a project setting.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Implicit flow (the supabase-js default) returns the recovery token in the
    // URL hash, which the /reset-password page reads when a reset link opens.
    // Pinned explicitly so a future library default change can never silently
    // break the recovery landing experience.
    flowType: "implicit",
  },
});

// supabase-js already refreshes when a hidden tab becomes visible again; this also covers the network returning and a device
// waking from sleep, where the page can stay "visible" but its refresh timer was frozen. startAutoRefresh is safe to repeat.
if (typeof window !== "undefined") {
  const kick = () => { if (document.visibilityState === "visible") void supabase.auth.startAutoRefresh(); };
  window.addEventListener("online", kick);
  window.addEventListener("focus", kick);
  document.addEventListener("visibilitychange", kick);
}
