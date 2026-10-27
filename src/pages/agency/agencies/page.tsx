import { useCallback, useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { Link } from "react-router-dom";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";
import {
  deleteAgency,
  invokePortalUsers,
  listAgencies,
  setAgencyStatus,
  updateAgency,
} from "@/pages/agency/lib/portalData";
import type { PortalAgency } from "@/pages/agency/lib/portalAuthContext";
import {
  PageHeading,
  PermanentBadge,
  PortalEmpty,
  PortalError,
  PortalLoading,
  PortalModal,
} from "@/pages/agency/components/PortalUI";

const fieldClass =
  "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
const labelClass = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700";

const EMPTY_FORM = {
  name: "",
  code: "",
  registration_number: "",
  business_email: "",
  phone: "",
  address: "",
  country: "",
  primary_contact: "",
};

type FormState = typeof EMPTY_FORM;

function AgencyFields({
  form,
  onChange,
}: {
  form: FormState;
  onChange: (key: keyof FormState, value: string) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <div>
        <label className={labelClass}>Agency name *</label>
        <input className={fieldClass} value={form.name} onChange={(e) => onChange("name", e.target.value)} placeholder="e.g. Global Pathways Education" />
      </div>
      <div>
        <label className={labelClass}>Unique agency code *</label>
        <input className={fieldClass} value={form.code} onChange={(e) => onChange("code", e.target.value)} placeholder="e.g. GPE-001" />
      </div>
      <div>
        <label className={labelClass}>Registration / ABN</label>
        <input className={fieldClass} value={form.registration_number} onChange={(e) => onChange("registration_number", e.target.value)} />
      </div>
      <div>
        <label className={labelClass}>Primary contact</label>
        <input className={fieldClass} value={form.primary_contact} onChange={(e) => onChange("primary_contact", e.target.value)} />
      </div>
      <div>
        <label className={labelClass}>Business email</label>
        <input className={fieldClass} type="email" value={form.business_email} onChange={(e) => onChange("business_email", e.target.value)} />
      </div>
      <div>
        <label className={labelClass}>Phone</label>
        <input className={fieldClass} type="tel" value={form.phone} onChange={(e) => onChange("phone", e.target.value)} />
      </div>
      <div>
        <label className={labelClass}>Country</label>
        <input className={fieldClass} value={form.country} onChange={(e) => onChange("country", e.target.value)} />
      </div>
      <div className="md:col-span-2">
        <label className={labelClass}>Address</label>
        <input className={fieldClass} value={form.address} onChange={(e) => onChange("address", e.target.value)} />
      </div>
    </div>
  );
}

function toForm(agency: PortalAgency): FormState {
  return {
    name: agency.name,
    code: agency.code,
    registration_number: agency.registrationNumber,
    business_email: agency.businessEmail,
    phone: agency.phone,
    address: agency.address,
    country: agency.country,
    primary_contact: agency.primaryContact,
  };
}

export default function AdminAgenciesPage() {
  const [agencies, setAgencies] = useState<PortalAgency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [admin, setAdmin] = useState({ name: "", email: "" });
  const [createNotice, setCreateNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [editing, setEditing] = useState<PortalAgency | null>(null);
  const [editForm, setEditForm] = useState<FormState>({ ...EMPTY_FORM });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState("");

  const [deleting, setDeleting] = useState<PortalAgency | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setAgencies(await listAgencies());
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load agencies.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (key: keyof FormState, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const updateEdit = (key: keyof FormState, value: string) => setEditForm((prev) => ({ ...prev, [key]: value }));

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    setFormError("");
    setCreateNotice("");
    if (!form.name.trim() || !form.code.trim() || !admin.email.trim() || !admin.name.trim()) {
      setFormError("Agency name, a unique agency code and the first administrator's name and email are required.");
      return;
    }
    setSaving(true);
    try {
      // One transaction in the database: the agency and its first admin invitation exist together or not at all.
      const data = await invokePortalUsers({
        action: "create_agency",
        agency: {
          name: form.name.trim(),
          code: form.code.trim(),
          registration_number: form.registration_number.trim(),
          business_email: form.business_email.trim(),
          phone: form.phone.trim(),
          address: form.address.trim(),
          country: form.country.trim(),
          primary_contact: form.primary_contact.trim(),
        },
        adminEmail: admin.email.trim(),
        adminName: admin.name.trim(),
        redirectTo: portalPasswordResetUrl(),
      });
      setCreateNotice(data.warning ? String(data.warning) : `Agency created. An invitation was ${data.emailSent ? "emailed" : "saved"} for ${admin.email.trim()}.`);
      setAdmin({ name: "", email: "" });
      setForm({ ...EMPTY_FORM });
      setShowForm(false);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "We could not create this agency.");
    } finally {
      setSaving(false);
    }
  };

  const openEdit = (agency: PortalAgency) => {
    setEditing(agency);
    setEditForm(toForm(agency));
    setEditError("");
  };

  const handleUpdate = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setEditError("");
    if (!editForm.name.trim() || !editForm.code.trim()) {
      setEditError("Agency name and a unique agency code are required.");
      return;
    }
    setEditSaving(true);
    try {
      await updateAgency(editing.id, {
        name: editForm.name,
        code: editForm.code,
        registrationNumber: editForm.registration_number,
        businessEmail: editForm.business_email,
        phone: editForm.phone,
        address: editForm.address,
        country: editForm.country,
        primaryContact: editForm.primary_contact,
      });
      setEditing(null);
      await load();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "We could not save these changes.");
    } finally {
      setEditSaving(false);
    }
  };

  const toggleStatus = async (agency: PortalAgency) => {
    setBusyId(agency.id);
    const next = agency.status === "Active" ? "Inactive" : "Active";
    try {
      await setAgencyStatus(agency.id, next);
      setAgencies((prev) => prev.map((a) => (a.id === agency.id ? { ...a, status: next } : a)));
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not change that agency's status.");
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    setDeleteBusy(true);
    setDeleteError("");
    try {
      await deleteAgency(deleting.id);
      setAgencies((prev) => prev.filter((a) => a.id !== deleting.id));
      setDeleting(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "We could not delete this agency.");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div>
      <PageHeading
        eyebrow="Agencies"
        title="Agencies"
        description="Create and manage the education agencies that submit student applications. Agencies marked Permanent are reference records and are never removed by automated routines."
        action={
          <button
            type="button"
            onClick={() => setShowForm((v) => !v)}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600"
          >
            <i className={showForm ? "ri-close-line" : "ri-add-line"} aria-hidden="true" />
            {showForm ? "Cancel" : "New agency"}
          </button>
        }
      />

      {createNotice ? (
        <p className="mt-4 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-sm text-secondary-900" role="status">{createNotice}</p>
      ) : null}

      {showForm ? (
        <form onSubmit={handleCreate} className="mt-6 rounded-card border border-background-200 bg-background-50 p-6">
          <h2 className="font-heading text-base font-semibold text-foreground-950">New agency</h2>
          <div className="mt-4">
            <AgencyFields form={form} onChange={update} />
          </div>
          <h3 className="mt-6 font-heading text-sm font-semibold text-foreground-950">First agency administrator</h3>
          <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className={labelClass}>Administrator name *</label>
              <input className={fieldClass} value={admin.name} onChange={(e) => setAdmin((prev) => ({ ...prev, name: e.target.value }))} />
            </div>
            <div>
              <label className={labelClass}>Administrator email *</label>
              <input className={fieldClass} type="email" value={admin.email} onChange={(e) => setAdmin((prev) => ({ ...prev, email: e.target.value }))} />
            </div>
          </div>

          {formError ? (
            <p className="mt-4 flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900" role="alert">
              <i className="ri-error-warning-line" aria-hidden="true" />
              {formError}
            </p>
          ) : null}

          <div className="mt-5">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:opacity-70"
            >
              {saving ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-save-3-line" aria-hidden="true" />}
              {saving ? "Saving\u2026" : "Create agency"}
            </button>
          </div>
        </form>
      ) : null}

      <div className="mt-6">
        {loading ? (
          <PortalLoading label="Loading agencies\u2026" />
        ) : error ? (
          <PortalError message={error} onRetry={() => void load()} />
        ) : agencies.length === 0 ? (
          <PortalEmpty icon="ri-building-2-line" title="No agencies yet" message="Create your first agency to begin provisioning agent accounts." />
        ) : (
          <ul className="space-y-3">
            {agencies.map((agency) => (
              <li
                key={agency.id}
                className="flex flex-col gap-3 rounded-lg border border-background-200 bg-background-50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-primary-100 text-xl text-primary-700">
                    <i className="ri-building-2-line" aria-hidden="true" />
                  </span>
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground-950">
                      <span className="truncate">{agency.name}</span>
                      {agency.isPermanent ? <PermanentBadge /> : null}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground-500">
                      <span className="rounded-full bg-secondary-100 px-2 py-0.5 font-medium text-secondary-900">{agency.code}</span>
                      {agency.businessEmail ? <span>{agency.businessEmail}</span> : null}
                      {agency.country ? <span>&middot; {agency.country}</span> : null}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                      agency.status === "Active" ? "bg-accent-100 text-accent-900" : "bg-background-200 text-foreground-600"
                    }`}
                  >
                    {agency.status}
                  </span>
                  <Link
                    to="/agency/users"
                    className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
                  >
                    <i className="ri-group-line" aria-hidden="true" />
                    Users
                  </Link>
                  <button
                    type="button"
                    onClick={() => openEdit(agency)}
                    className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700"
                  >
                    <i className="ri-edit-line" aria-hidden="true" />
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleStatus(agency)}
                    disabled={busyId === agency.id}
                    className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3.5 py-2 text-xs font-semibold text-foreground-800 transition-colors hover:border-primary-300 hover:text-primary-700 disabled:opacity-60"
                  >
                    {agency.status === "Active" ? "Deactivate" : "Activate"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleting(agency);
                      setDeleteError("");
                    }}
                    aria-label={`Delete ${agency.name}`}
                    className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-primary-200 bg-background-50 px-3 py-2 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50"
                  >
                    <i className="ri-delete-bin-line" aria-hidden="true" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Edit agency */}
      <PortalModal
        open={Boolean(editing)}
        title="Edit agency"
        description="Update this agency's information. Changes take effect immediately across the portal."
        onClose={() => setEditing(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="agency-edit-form"
              disabled={editSaving}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:opacity-70"
            >
              {editSaving ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-save-3-line" aria-hidden="true" />}
              {editSaving ? "Saving\u2026" : "Save changes"}
            </button>
          </>
        }
      >
        <form id="agency-edit-form" onSubmit={handleUpdate}>
          <AgencyFields form={editForm} onChange={updateEdit} />
          {editError ? (
            <p className="mt-4 flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900" role="alert">
              <i className="ri-error-warning-line" aria-hidden="true" />
              {editError}
            </p>
          ) : null}
        </form>
      </PortalModal>

      {/* Delete agency */}
      <PortalModal
        open={Boolean(deleting)}
        title="Delete agency"
        description={deleting ? `You are about to delete ${deleting.name}.` : undefined}
        onClose={() => setDeleting(null)}
        footer={
          <>
            <button
              type="button"
              onClick={() => setDeleting(null)}
              className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleDelete()}
              disabled={deleteBusy}
              className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-600 px-6 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-700 disabled:opacity-70"
            >
              {deleteBusy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-delete-bin-line" aria-hidden="true" />}
              {deleteBusy ? "Deleting\u2026" : "Delete agency"}
            </button>
          </>
        }
      >
        {deleting?.isPermanent ? (
          <p className="flex items-start gap-2 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-3 text-sm text-secondary-900" role="note">
            <i className="ri-shield-star-line mt-0.5" aria-hidden="true" />
            <span>
              <strong className="font-semibold">{deleting.name}</strong> is a permanent reference agency. Deleting it will remove a record that is
              expected to remain available. Only continue if this is intentional.
            </span>
          </p>
        ) : (
          <p className="text-sm text-foreground-600">
            This permanently removes the agency. An agency that still owns student applications cannot be deleted until those applications are
            removed.
          </p>
        )}
        {deleteError ? (
          <p className="mt-4 flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900" role="alert">
            <i className="ri-error-warning-line" aria-hidden="true" />
            {deleteError}
          </p>
        ) : null}
      </PortalModal>
    </div>
  );
}