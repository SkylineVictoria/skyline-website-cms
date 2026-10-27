import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { usePortalAuth } from "../lib/portalAuthContext";
import { PageHeading, PortalError } from "./PortalUI";
interface ScopedAgent { profileId: string; name: string; email: string; agencyId: string; agencyName: string; active: boolean }
export default function InstitutionAgents() {
  const { selectedScope } = usePortalAuth();
  const [rows, setRows] = useState<ScopedAgent[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("portal_scope_agents");
    if (error) throw new Error(error.message);
    setRows(data ?? []);
  }, []);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function toggle(row: ScopedAgent) {
    setBusy(true); setError("");
    try {
      const { error } = await supabase.rpc("portal_set_agent_scope", { p_tenant: selectedScope?.tenantId, p_agency: row.agencyId, p_profile: row.profileId, p_active: !row.active });
      if (error) throw new Error(error.message);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not update institution access."); }
    finally { setBusy(false); }
  }
  return <div><PageHeading eyebrow="Users" title="Institution agents" description={`Manage agent access to ${selectedScope?.name ?? "this institution"}.`} />
    {error ? <PortalError message={error} /> : null}
    <ul className="mt-6 divide-y rounded border bg-background-50">{rows.map(row => <li className="flex items-center justify-between gap-4 p-4" key={row.profileId}>
      <div><strong>{row.name}</strong><p>{row.email}</p><p>{row.agencyName}</p></div>
      <button disabled={busy} className="rounded border px-4 py-2" aria-label={`${row.active ? "Revoke" : "Grant"} ${row.name}`} onClick={() => void toggle(row)}>{row.active ? "Revoke access" : "Grant access"}</button>
    </li>)}</ul>
  </div>;
}
