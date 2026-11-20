import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { adminListStaff, adminSaveEmployment, type StaffDetail, type StaffEmployment, type StaffEmploymentForm, type StaffListRow } from "@/lib/staffApi";
import { listLocations, type HrLocation } from "@/lib/hrmsApi";
import { STAFF_LOCATIONS_PATH } from "@/pages/admin/lib/staffRoutes";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";

/**
 * The employment fields of hr.employment (HR-02j; 2026-11-11: the work location is picked from HRMS > Locations and the job type is
 * Full time, Part time or Contract). The manager is an active employee (searched by name); the joining date is set with the pay
 * details. Used on the onboarding page and on Staff > Employees for active people.
 */
export default function EmploymentDialog({ profileId, employment, onClose, onSaved }: {
  profileId: string; employment: StaffEmployment | null; onClose: () => void; onSaved: (detail: StaffDetail) => void;
}) {
  const [form, setForm] = useState<StaffEmploymentForm>({
    department: employment?.department ?? "", jobTitle: employment?.jobTitle ?? "",
    employmentType: employment?.employmentType === "casual" ? "" : (employment?.employmentType ?? ""), managerId: employment?.managerId ?? "", locationId: employment?.locationId ?? "",
  });
  const [managerSearch, setManagerSearch] = useState("");
  const [managers, setManagers] = useState<StaffListRow[]>([]);
  const [locations, setLocations] = useState<HrLocation[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const patch = (p: Partial<StaffEmploymentForm>) => setForm((f) => ({ ...f, ...p }));

  useEffect(() => {
    let live = true;
    listLocations().then((rows) => { if (live) setLocations(rows); }, () => { if (live) setLocations([]); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void adminListStaff(["active"], managerSearch, 25, 0).then((data) => { if (current) setManagers(data.rows.filter((m) => m.id !== profileId)); }, () => { if (current) setManagers([]); });
    }, 200);
    return () => { current = false; window.clearTimeout(timer); };
  }, [managerSearch, profileId]);

  const save = async () => {
    setBusy(true); setError("");
    try { onSaved(await adminSaveEmployment(profileId, form)); }
    catch (e) { setError(e instanceof Error ? e.message : "The employment details could not be saved."); }
    finally { setBusy(false); }
  };
  const currentManager = employment?.managerId && !managers.some((m) => m.id === employment.managerId) ? { id: employment.managerId, name: employment.managerName ?? "Current manager" } : null;
  const choices = (locations ?? []).filter((l) => l.isActive || l.id === form.locationId);
  return (
    <Modal open title="Employment details" onClose={() => { if (!busy) onClose(); }}
      footer={<><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="staff-employment-save">{busy ? "Saving…" : "Save"}</Button></>}>
      <div className="space-y-3" data-testid="staff-employment-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Job title"><TextInput maxLength={150} value={form.jobTitle} onChange={(e) => patch({ jobTitle: e.target.value })} data-testid="staff-employment-title" /></Field>
          <Field label="Department"><TextInput maxLength={120} value={form.department} onChange={(e) => patch({ department: e.target.value })} data-testid="staff-employment-department" /></Field>
          <Field label="Job type"><Select value={form.employmentType} onChange={(e) => patch({ employmentType: e.target.value as StaffEmploymentForm["employmentType"] })} data-testid="staff-employment-type">
            <option value="">Not set</option><option value="full_time">Full time</option><option value="part_time">Part time</option><option value="contract">Contract</option>
          </Select></Field>
          <Field label="Work location" hint={locations && locations.length === 0 ? "No locations yet: add one under HRMS › Locations." : undefined}>
            <Select value={form.locationId} onChange={(e) => patch({ locationId: e.target.value })} data-testid="staff-employment-location">
              <option value="">Not set</option>
              {choices.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isActive ? "" : " (inactive)"}</option>)}
            </Select>
          </Field>
          <Field label="Find a manager" hint="Active employees only."><TextInput placeholder="Search by name or email" value={managerSearch} onChange={(e) => setManagerSearch(e.target.value)} /></Field>
          <Field label="Manager"><Select value={form.managerId} onChange={(e) => patch({ managerId: e.target.value })} data-testid="staff-employment-manager">
            <option value="">No manager assigned</option>
            {currentManager ? <option value={currentManager.id}>{currentManager.name}</option> : null}
            {managers.map((m) => <option key={m.id} value={m.id}>{m.name || m.email}</option>)}
          </Select></Field>
        </div>
        <p className="text-xs text-foreground-600">
          Locations are managed under <Link to={STAFF_LOCATIONS_PATH} className="font-semibold text-primary-700 hover:underline">HRMS › Locations</Link>. The pay type (fortnightly or monthly) is the pay schedule chosen in the pay details.
          The start date comes from the pay details and is confirmed at activation{employment?.joiningDate ? ` (${new Date(`${employment.joiningDate}T00:00:00`).toLocaleDateString()})` : ""}.
        </p>
        {error ? <p role="alert" className={ALERT} data-testid="staff-employment-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
