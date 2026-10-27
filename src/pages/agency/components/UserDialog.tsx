import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { Dialog } from "@/pages/agency/components/Dialog";
import {
  mapServerError, normaliseEmail, validateField, validateUserForm,
  type UserFormContext, type UserFormErrors, type UserFormValues,
} from "@/pages/agency/lib/userValidation";

const inputClass =
  "w-full rounded-md border bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:outline-none focus:ring-2 read-only:bg-background-100 read-only:text-foreground-600 disabled:bg-background-100";
const labelClass = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700";

function FieldRow({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: (props: { id: string; "aria-invalid": boolean; "aria-describedby"?: string; className: string }) => ReactNode }) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className={labelClass}>{label}</label>
      {children({ id, "aria-invalid": Boolean(error), "aria-describedby": describedBy, className: `${inputClass} ${error ? "border-primary-500 focus:ring-primary-400/40" : "border-background-300 focus:border-primary-500 focus:ring-primary-400/40"}` })}
      {error ? <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-medium text-primary-700">{error}</p> : hint ? <p id={`${id}-hint`} className="mt-1.5 text-xs text-foreground-500">{hint}</p> : null}
    </div>
  );
}

export interface UserDialogProps {
  open: boolean;
  mode: "add" | "edit";
  initial: UserFormValues;
  roles: { value: string; label: string }[];
  agencies?: { id: string; name: string }[];       // shown only to organization administrators
  existingEmails: string[];
  nameEditable: boolean;
  /** Reason a role change is refused (e.g. last administrator), or null. */
  roleBlock?: (role: string) => string | null;
  onClose: () => void;
  /** Resolve on success; throw on failure (the message is mapped, never shown raw). */
  onSubmit: (values: UserFormValues) => Promise<void>;
}

/** One dialog for adding and editing a portal user. Validation: pure module, inline on blur and submit. */
export function UserDialog({ open, mode, initial, roles, agencies, existingEmails, nameEditable, roleBlock, onClose, onSubmit }: UserDialogProps) {
  const uid = useId();
  const [values, setValues] = useState<UserFormValues>(initial);
  const [errors, setErrors] = useState<UserFormErrors>({});
  const [topError, setTopError] = useState("");
  const [busy, setBusy] = useState(false);

  // Reset whenever the dialog is (re)opened for a user.
  useEffect(() => { if (open) { setValues(initial); setErrors({}); setTopError(""); setBusy(false); } }, [open, initial]);

  const ctx: UserFormContext = { mode, existingEmails, allowedRoles: roles.map((r) => r.value), needsAgency: Boolean(agencies), nameEditable };
  const set = (field: keyof UserFormValues, value: string) => setValues((prev) => ({ ...prev, [field]: value }));
  const blur = (field: keyof UserFormValues) => {
    const message = validateField(field, values, ctx) ?? (field === "role" ? roleBlock?.(values.role) ?? null : null);
    setErrors((prev) => ({ ...prev, [field]: message ?? undefined }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next = validateUserForm(values, ctx);
    const blocked = roleBlock?.(values.role);
    if (blocked && !next.role) next.role = blocked;
    setErrors(next);
    setTopError("");
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      await onSubmit({ ...values, name: values.name.trim(), email: normaliseEmail(values.email) });
    } catch (e) {
      const mapped = mapServerError(e);
      if (mapped.field) setErrors((prev) => ({ ...prev, [mapped.field as keyof UserFormValues]: mapped.message }));
      else setTopError(mapped.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={mode === "add" ? "Add user" : "Edit user"}
      description={mode === "add" ? "They receive an email invitation to set their own password." : "Update this user's role. The email address cannot be changed."}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-700 transition-colors hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-60">Cancel</button>
          <button type="submit" form={`${uid}-form`} disabled={busy} className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70">
            {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className={mode === "add" ? "ri-mail-send-line" : "ri-save-3-line"} aria-hidden="true" />}
            {busy ? "Saving…" : mode === "add" ? "Send invitation" : "Save changes"}
          </button>
        </>
      }
    >
      <form id={`${uid}-form`} onSubmit={submit} noValidate className="space-y-4">
        {topError ? (
          <p role="alert" className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900"><i className="ri-error-warning-line mt-0.5" aria-hidden="true" />{topError}</p>
        ) : null}
        <FieldRow id={`${uid}-name`} label="Full name" error={errors.name} hint={nameEditable ? undefined : "Only the user or an organization administrator can change a name."}>
          {(p) => <input {...p} value={values.name} onChange={(e) => set("name", e.target.value)} onBlur={() => blur("name")} readOnly={!nameEditable} maxLength={120} autoComplete="off" placeholder="e.g. Priya Nair" />}
        </FieldRow>
        <FieldRow id={`${uid}-email`} label="Email address" error={errors.email}>
          {(p) => <input {...p} type="email" value={values.email} onChange={(e) => set("email", e.target.value)} onBlur={() => { set("email", values.email.trim()); blur("email"); }} readOnly={mode === "edit"} maxLength={254} autoComplete="off" placeholder="user@agency.com" />}
        </FieldRow>
        <FieldRow id={`${uid}-role`} label="Role" error={errors.role}>
          {(p) => (
            <select {...p} value={values.role} onChange={(e) => set("role", e.target.value)} onBlur={() => blur("role")}>
              {roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          )}
        </FieldRow>
        {agencies ? (
          <FieldRow id={`${uid}-agency`} label="Agency" error={errors.agencyId}>
            {(p) => (
              <select {...p} value={values.agencyId} onChange={(e) => set("agencyId", e.target.value)} onBlur={() => blur("agencyId")}>
                <option value="">Select an agency</option>
                {agencies.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            )}
          </FieldRow>
        ) : null}
      </form>
    </Dialog>
  );
}

/** Small confirmation for deactivating / reactivating a user. A refusal reason disables the action and explains why. */
export function ConfirmUserDialog({ open, name, action, blockedReason, onClose, onConfirm }: {
  open: boolean; name: string; action: "deactivate" | "reactivate"; blockedReason: string | null; onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) { setBusy(false); setError(""); } }, [open]);
  const label = action === "deactivate" ? "Deactivate" : "Reactivate";
  const confirm = async () => {
    if (busy || blockedReason) return;
    setBusy(true); setError("");
    try { await onConfirm(); } catch (e) { setError(mapServerError(e).message); setBusy(false); }
  };
  return (
    <Dialog
      open={open}
      busy={busy}
      onClose={onClose}
      title={`${label} ${name || "this user"}?`}
      description={action === "deactivate" ? "They will no longer be able to sign in to the portal. Their records are kept and you can reactivate them later." : "They will be able to sign in to the portal again."}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="cursor-pointer whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-5 py-2.5 text-sm font-semibold text-foreground-700 hover:bg-background-100 disabled:cursor-not-allowed disabled:opacity-60">Cancel</button>
          <button type="button" onClick={() => void confirm()} disabled={busy || Boolean(blockedReason)} className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : null}{busy ? "Working…" : label}
          </button>
        </>
      }
    >
      {blockedReason || error ? <p role="alert" className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900"><i className="ri-error-warning-line mt-0.5" aria-hidden="true" />{blockedReason || error}</p> : null}
    </Dialog>
  );
}
