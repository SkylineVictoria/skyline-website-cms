import { useEffect, useState, type FormEvent } from "react";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { ROLE_LABELS } from "@/pages/agency/lib/portalData";
import { PageHeading } from "@/pages/agency/components/PortalUI";
import { passwordProblem, MIN_PASSWORD_LENGTH } from "@/lib/passwords";

const fieldClass =
  "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";
const labelClass = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-foreground-700";

export default function PortalProfilePage() {
  const { authUser, role, profile, agency, updateOwnProfile, changeOwnPassword } = usePortalAuth();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSaved, setPasswordSaved] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.fullName ?? "");
    setPhone(profile.phone ?? "");
    setJobTitle(profile.jobTitle ?? "");
  }, [profile]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (!fullName.trim()) {
      setError("Please enter your full name.");
      return;
    }
    setBusy(true);
    const result = await updateOwnProfile({ fullName: fullName.trim(), phone, jobTitle });
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? "We could not save your profile. Please try again.");
      return;
    }
    setSaved(true);
  };

  const isSlit = role === "slit_admin";
  const changePassword = async (event: FormEvent) => {
    event.preventDefault(); setPasswordError(""); setPasswordSaved(false);
    if (!currentPassword) { setPasswordError("Enter your current password."); return; }
    const problem = passwordProblem(newPassword, confirmPassword);
    if (problem) { setPasswordError(problem); return; }
    setPasswordBusy(true);
    const result = await changeOwnPassword(currentPassword, newPassword);
    setPasswordBusy(false);
    if (!result.ok) { setPasswordError(result.error ?? "We could not change your password."); return; }
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); setPasswordSaved(true);
  };

  return (
    <div>
      <PageHeading
        eyebrow="My Profile"
        title="My profile"
        description="Your portal account details. This is separate from any student application data you prepare on a student's behalf."
      />

      <form onSubmit={handleSubmit} className="mt-6 rounded-card border border-background-200 bg-background-50 p-6 md:p-7">
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="md:col-span-2">
            <label htmlFor="profile-name" className={labelClass}>
              Full name
            </label>
            <input
              id="profile-name"
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              placeholder="Your full name"
              autoComplete="name"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="profile-email" className={labelClass}>
              Sign-in email
            </label>
            <input
              id="profile-email"
              type="email"
              value={authUser?.email ?? ""}
              readOnly
              className={`${fieldClass} cursor-not-allowed bg-background-100 text-foreground-500`}
            />
          </div>

          <div>
            <label htmlFor="profile-job" className={labelClass}>
              Job title
            </label>
            <input
              id="profile-job"
              type="text"
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
              placeholder="e.g. Senior Counsellor"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="profile-phone" className={labelClass}>
              Phone number
            </label>
            <input
              id="profile-phone"
              type="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="e.g. +61 400 000 000"
              autoComplete="tel"
              className={fieldClass}
            />
          </div>

          <div>
            <label htmlFor="profile-role" className={labelClass}>
              Role
            </label>
            <input
              id="profile-role"
              type="text"
              value={role ? ROLE_LABELS[role] : ""}
              readOnly
              className={`${fieldClass} cursor-not-allowed bg-background-100 text-foreground-500`}
            />
          </div>

          {!isSlit ? (
            <div className="md:col-span-2">
              <label htmlFor="profile-agency" className={labelClass}>
                Agency
              </label>
              <input
                id="profile-agency"
                type="text"
                value={agency ? `${agency.name} (${agency.code})` : ""}
                readOnly
                className={`${fieldClass} cursor-not-allowed bg-background-100 text-foreground-500`}
              />
              <p className="mt-1.5 text-xs text-foreground-500">
                Your agency and role are managed by SLIT Administration and can&rsquo;t be changed here.
              </p>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="mt-5 flex items-center gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900" role="alert">
            <i className="ri-error-warning-line" aria-hidden="true" />
            {error}
          </p>
        ) : null}
        {saved ? (
          <p className="mt-5 flex items-center gap-2 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-sm text-secondary-900" role="status">
            <i className="ri-checkbox-circle-line" aria-hidden="true" />
            Your profile has been saved.
          </p>
        ) : null}

        <div className="mt-6">
          <button
            type="submit"
            disabled={busy}
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {busy ? <i className="ri-loader-4-line animate-spin" aria-hidden="true" /> : <i className="ri-save-3-line" aria-hidden="true" />}
            {busy ? "Saving\u2026" : "Save changes"}
          </button>
        </div>
      </form>

      <form onSubmit={changePassword} className="mt-6 rounded-card border border-background-200 bg-background-50 p-6 md:p-7">
        <h2 className="font-heading text-lg font-semibold text-foreground-950">Change password</h2>
        <p className="mt-1 text-sm text-foreground-600">Confirm your current password before choosing a new one.</p>
        <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-2">
          <div className="md:col-span-2"><label className={labelClass}>Current password</label><input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" className={fieldClass} /></div>
          <div><label className={labelClass}>New password</label><input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" className={fieldClass} /></div>
          <div><label className={labelClass}>Confirm new password</label><input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" className={fieldClass} /></div>
        </div>
        <p className="mt-2 text-xs text-foreground-500">Use at least {MIN_PASSWORD_LENGTH} characters; Supabase password policies also apply.</p>
        {passwordError && <p role="alert" className="mt-4 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-sm text-primary-900">{passwordError}</p>}
        {passwordSaved && <p role="status" className="mt-4 rounded-md border border-secondary-200 bg-secondary-50 px-3 py-2.5 text-sm text-secondary-900">Your password has been changed.</p>}
        <button type="submit" disabled={passwordBusy} className="mt-5 inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 disabled:opacity-70">{passwordBusy ? "Updating…" : "Change password"}</button>
      </form>
    </div>
  );
}
