// Runtime-neutral validation. Values never leave this module in error results.
export type ConfigurationIssue = { error: string; code: string; variables: string[] };

export function requiredConfiguration(values: Record<string, string>): ConfigurationIssue | null {
  const variables = Object.entries(values).filter(([, value]) => !value.trim()).map(([name]) => name);
  return variables.length ? { error: "Edge Function configuration is unavailable.", code: "configuration_unavailable", variables } : null;
}

export function backendConfiguration(url: string, serviceKey: string, anonKey?: string): ConfigurationIssue | null {
  const required: Record<string, string> = { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey };
  if (anonKey !== undefined) required["SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY"] = anonKey;
  const missing = requiredConfiguration(required);
  if (missing) return missing;
  try {
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("invalid_url");
  } catch {
    return { error: "Edge Function configuration is unavailable.", code: "configuration_invalid", variables: ["SUPABASE_URL"] };
  }
  return null;
}
