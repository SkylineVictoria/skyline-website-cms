import { useEffect, useState } from "react";
import SearchPick, { type PickOption } from "@/pages/admin/components/SearchPick";
import { addStaffRoleType, listStaffRoleTypes, type StaffRoleType } from "@/lib/staffRolesApi";
import type { StaffRole } from "@/lib/staffStatus";

const ACCESS_LABEL: Record<StaffRole, string> = { trainer: "Trainer access", admin: "Admin access" };

/**
 * Searchable role list with "Add new role". A new role takes the system access of Trainer or Admin (for now; per-role permissions
 * come later on a Roles page). Shows the chosen role as a chip with Change.
 */
export default function StaffRolePicker({ value, onChange, disabled, problem }: {
  value: StaffRoleType | null; onChange: (role: StaffRoleType | null) => void; disabled?: boolean; problem?: string;
}) {
  const [roles, setRoles] = useState<StaffRoleType[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [adding, setAdding] = useState<{ label: string; access: StaffRole } | null>(null);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState("");

  useEffect(() => {
    let live = true;
    listStaffRoleTypes().then((list) => { if (live) setRoles(list); }).catch((e) => { if (live) setLoadError(e instanceof Error ? e.message : "The roles could not be loaded."); });
    return () => { live = false; };
  }, []);

  const search = async (q: string): Promise<PickOption[]> => {
    const list = roles ?? await listStaffRoleTypes();
    const needle = q.trim().toLowerCase();
    return list.filter((r) => !needle || r.label.toLowerCase().includes(needle))
      .map((r) => ({ id: r.key, label: r.label, meta: r.system ? "Built in" : ACCESS_LABEL[r.access] }));
  };

  const saveNew = async () => {
    if (!adding || saving) return;
    const label = adding.label.trim().replace(/\s+/g, " ");
    if (label.length < 2 || label.length > 60) { setAddError("Enter a role name (2 to 60 characters)."); return; }
    setSaving(true); setAddError("");
    try {
      const made = await addStaffRoleType(label, adding.access);
      const role: StaffRoleType = { key: made.key, label: made.label, access: made.access, system: made.system };
      setRoles((list) => (list && !list.some((r) => r.key === role.key) ? [...list, role] : list));
      onChange(role);
      setAdding(null);
    } catch (e) { setAddError(e instanceof Error ? e.message : "The role could not be added."); }
    finally { setSaving(false); }
  };

  if (value) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-background-300 bg-background-50 px-3 py-2" data-testid="staff-role-chosen">
        <span className="text-sm"><strong className="text-foreground-950">{value.label}</strong>
          {!value.system ? <span className="ml-2 text-xs text-foreground-600">{ACCESS_LABEL[value.access]}</span> : null}</span>
        <button type="button" disabled={disabled} onClick={() => onChange(null)} className="text-sm font-semibold text-primary-700 hover:underline disabled:opacity-50">Change</button>
      </div>
    );
  }

  if (adding) {
    return (
      <div className="space-y-3 rounded-md border border-primary-200 bg-primary-50/40 p-3" data-testid="staff-role-new">
        <label className="block text-sm font-medium text-foreground-800">New role name
          <input value={adding.label} maxLength={60} autoFocus disabled={saving} onChange={(e) => setAdding({ ...adding, label: e.target.value })}
            className="mt-1 w-full rounded-md border border-background-300 bg-white px-3 py-2 text-sm" data-testid="staff-role-new-name" />
        </label>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-foreground-800">What can they open in the system?</legend>
          <div className="flex flex-wrap gap-2">
            {(["trainer", "admin"] as StaffRole[]).map((a) => (
              <button key={a} type="button" disabled={saving} aria-pressed={adding.access === a} onClick={() => setAdding({ ...adding, access: a })} data-testid={`staff-role-new-${a}`}
                className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${adding.access === a ? "border-primary-500 bg-primary-50 text-primary-800" : "border-background-300 bg-white text-foreground-700"}`}>
                {a === "trainer" ? "Same as Trainer" : "Same as Admin"}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-xs text-foreground-600">{adding.access === "admin" ? "Full access to the admin console." : "Their classes, attendance and marking."} You can give each role its own pages later.</p>
        </fieldset>
        {addError ? <p role="alert" className="text-xs text-primary-700">{addError}</p> : null}
        <div className="flex justify-end gap-2">
          <button type="button" disabled={saving} onClick={() => { setAdding(null); setAddError(""); }} className="rounded-md border border-background-300 bg-white px-3 py-1.5 text-sm font-semibold text-foreground-800">Cancel</button>
          <button type="button" disabled={saving} onClick={() => void saveNew()} className="rounded-md bg-primary-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-primary-700" data-testid="staff-role-new-save">{saving ? "Adding…" : "Add role"}</button>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="staff-role-picker">
      <SearchPick label="Role" placeholder="Search roles, e.g. Trainer" search={search} searchWhenEmpty addNoun="role" disabled={disabled || (!roles && !loadError)}
        resetKey={roles ? String(roles.length) : "loading"}
        onPick={(option) => { const role = roles?.find((r) => r.key === option.id); if (role) onChange(role); }}
        onAddNew={(typed) => setAdding({ label: typed, access: "trainer" })} />
      <button type="button" disabled={disabled} onClick={() => setAdding({ label: "", access: "trainer" })}
        className="mt-1.5 inline-flex items-center gap-1 text-sm font-semibold text-primary-700 hover:underline disabled:opacity-50" data-testid="staff-role-add-new">
        <i className="ri-add-line" aria-hidden="true" />Add new role
      </button>
      {loadError ? <p role="alert" className="mt-1 text-xs text-primary-700">{loadError}</p> : null}
      {problem ? <p role="alert" className="mt-1 text-xs text-primary-700">{problem}</p> : null}
    </div>
  );
}
