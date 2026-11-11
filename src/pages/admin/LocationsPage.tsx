import { useCallback, useEffect, useState } from "react";
import { AdminError, AdminLoading, Badge, Button, Card, Field, Modal, PageHeader, TextInput, Toggle } from "@/pages/admin/components/ui";
import { listLocations, saveLocation, type HrLocation } from "@/lib/hrmsApi";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const NOTICE = "rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2 text-sm text-secondary-900";
type LocationForm = { id: string | null; name: string; address: string; isActive: boolean };

/**
 * HRMS > Locations: the work locations an employment record can name (hr.locations, 2026-11-11). Employment details and the pay
 * details pick from this list; the name fills {{job_location}} / {{work_location}} in letters. An inactive location stays on the
 * records that have it but cannot be chosen for anyone new.
 */
export default function LocationsPage() {
  const [locations, setLocations] = useState<HrLocation[] | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<LocationForm | null>(null);
  const [dialogError, setDialogError] = useState(""); const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setError(""); setLocations(await listLocations()); }
    catch (e) { setError(e instanceof Error ? e.message : "The locations could not be loaded."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!editing) return;
    if (!editing.name.trim()) { setDialogError("Give the location a name."); return; }
    setBusy(true); setDialogError("");
    try {
      await saveLocation(editing.id, { name: editing.name.trim(), address: editing.address.trim(), isActive: editing.isActive });
      setEditing(null); setNotice(editing.id ? "The location was saved." : "The location was added."); await load();
    } catch (e) { setDialogError(e instanceof Error ? e.message : "The location could not be saved."); }
    finally { setBusy(false); }
  };

  if (error && !locations) return <AdminError message={error} onRetry={() => void load()} />;
  if (!locations) return <AdminLoading label="Loading locations…" />;
  return (
    <div>
      <PageHeader breadcrumb="HRMS" title="Locations" description="The work locations an employee can be placed at. Employment details and the pay details pick from this list; the name fills the job location in offer letters."
        actions={<Button onClick={() => { setEditing({ id: null, name: "", address: "", isActive: true }); setDialogError(""); }} data-testid="location-new">New location</Button>} />
      {error ? <p role="alert" className={`mb-4 ${ALERT}`}>{error}</p> : null}
      {notice ? <p role="status" className={`mb-4 ${NOTICE}`} data-testid="location-notice">{notice}</p> : null}
      <Card className="p-5">
        {locations.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-sm" data-testid="locations-table">
              <thead className="text-xs uppercase tracking-wide text-foreground-600"><tr><th className="px-2 py-1">Name</th><th className="px-2 py-1">Address</th><th className="px-2 py-1">Employees</th><th className="px-2 py-1">Status</th><th className="px-2 py-1" /></tr></thead>
              <tbody className="divide-y divide-background-200">
                {locations.map((l) => (
                  <tr key={l.id} data-testid={`location-${l.id}`}>
                    <td className="px-2 py-1.5 font-medium text-foreground-950">{l.name}</td>
                    <td className="px-2 py-1.5 text-foreground-700">{l.address || <span className="text-foreground-500">—</span>}</td>
                    <td className="px-2 py-1.5">{l.employeeCount ?? 0}</td>
                    <td className="px-2 py-1.5"><Badge tone={l.isActive ? "success" : "muted"}>{l.isActive ? "Active" : "Inactive"}</Badge></td>
                    <td className="px-2 py-1.5 text-right"><Button size="sm" variant="outline" onClick={() => { setEditing({ id: l.id, name: l.name, address: l.address, isActive: l.isActive }); setDialogError(""); }} data-testid={`location-edit-${l.id}`}>Edit</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="text-sm text-foreground-600">No locations yet. Add the first one; it is then offered in the employment and pay details.</p>}
      </Card>
      <Modal open={editing !== null} title={editing?.id ? "Edit location" : "New location"} onClose={() => setEditing(null)}
        footer={<><Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="location-save">Save</Button></>}>
        {editing ? (
          <div className="space-y-3" data-testid="location-dialog">
            <Field label="Name" required><TextInput value={editing.name} maxLength={120} onChange={(e) => setEditing({ ...editing, name: e.target.value })} data-testid="location-name" /></Field>
            <Field label="Address" hint="Optional; shown on the record only."><TextInput value={editing.address} maxLength={300} onChange={(e) => setEditing({ ...editing, address: e.target.value })} data-testid="location-address" /></Field>
            <Toggle label="Active (can be chosen for employees)" checked={editing.isActive} onChange={(v) => setEditing({ ...editing, isActive: v })} />
            {editing.id ? <p className="text-xs text-foreground-600">Renaming a location renames it on every employee record that uses it.</p> : null}
            {dialogError ? <p role="alert" className={ALERT} data-testid="location-error">{dialogError}</p> : null}
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
