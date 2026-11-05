import { useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { mobileProblem, validEmail } from "@/lib/enrolForm";

/** Names from Google profile data, when it gave them. */
function namesFrom(user: User): { first: string; last: string } {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const first = String(meta.given_name ?? meta.first_name ?? "").trim();
  const last = String(meta.family_name ?? meta.last_name ?? "").trim();
  if (first || last) return { first, last };
  const full = String(meta.full_name ?? meta.name ?? "").trim().split(/\s+/).filter(Boolean);
  return { first: full.slice(0, -1).join(" ") || full[0] || "", last: full.length > 1 ? full[full.length - 1] : "" };
}

/**
 * After signing up with Google: the name and email come from Google, so the student only adds their mobile. Date of
 * birth, course and the rest are asked in the application form. A name or email Google did not give is asked here.
 */
export default function CompleteStudentProfile({ user, onDone, onCancel, embedded = false }: { user: User; onDone: () => void; onCancel: () => void; embedded?: boolean }) {
  const names = namesFrom(user);
  const emailVerified = Boolean(user.email && user.email_confirmed_at);
  const phoneVerified = Boolean(user.phone && user.phone_confirmed_at);
  const askName = !names.first || !names.last;
  const [first, setFirst] = useState(names.first);
  const [last, setLast] = useState(names.last);
  const [email, setEmail] = useState(emailVerified ? String(user.email) : "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const verifiedPhone = phoneVerified ? `+${String(user.phone).replace(/^\+/, "")}` : "";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const mobile = phoneVerified ? verifiedPhone : String(new FormData(event.currentTarget).get("mobile") ?? "");
    const next: Record<string, string> = {};
    if (!first.trim()) next.first = "Enter your first name.";
    if (!last.trim()) next.last = "Enter your last name.";
    if (!emailVerified && !validEmail(email)) next.email = "Enter a valid email address.";
    const mobileError = phoneVerified ? "" : mobileProblem(mobile); if (mobileError) next.mobile = mobileError;
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await supabase.rpc("portal_self_enrol_complete", {
      p_input: { firstName: first.trim(), lastName: last.trim(), email: email.trim().toLowerCase(), phone: mobile },
    });
    setBusy(false);
    if (error) { setErrors({ form: error.message || "We could not finish setting up your account. Please try again." }); return; }
    onDone();
  };

  const problem = (key: string) => (errors[key] ? <span className="mt-1 block text-xs text-primary-700" role="alert">{errors[key]}</span> : null);

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      {embedded ? null : (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Almost done · Student</p>
          <h2 className="mt-1 font-heading text-2xl font-bold text-foreground-950">Your details</h2>
        </>
      )}
      <div className={embedded ? "space-y-4" : "mt-6 space-y-4"}>
        {askName ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" required><TextInput value={first} onChange={(e) => setFirst(e.target.value)} autoComplete="given-name" />{problem("first")}</Field>
            <Field label="Last name" required><TextInput value={last} onChange={(e) => setLast(e.target.value)} autoComplete="family-name" />{problem("last")}</Field>
          </div>
        ) : null}
        {!askName || emailVerified ? (
          <dl className="space-y-1.5 rounded-lg border border-background-300 bg-background-50 p-3 text-sm">
            {!askName ? <div className="flex justify-between gap-3"><dt className="text-foreground-500">Name</dt><dd className="font-semibold text-foreground-900">{first} {last}</dd></div> : null}
            {emailVerified ? <div className="flex justify-between gap-3"><dt className="text-foreground-500">Email</dt><dd className="truncate font-semibold text-foreground-900">{email}</dd></div> : null}
          </dl>
        ) : null}
        {emailVerified ? null : (
          <Field label="Email" required><TextInput type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoComplete="email" />{problem("email")}</Field>
        )}
        {phoneVerified ? null : (
          <div>
            <label htmlFor="complete-mobile" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
            <PhoneInput id="complete-mobile" name="mobile" required placeholder="041 234 5678" />
            {problem("mobile")}
          </div>
        )}
        {errors.form ? <div className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-[13px] text-primary-900" role="alert">{errors.form}</div> : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Creating your account…" : "Create student account"}</Button>
        <p className="text-center text-xs text-foreground-500">
          By creating an account you agree to the <a href="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">terms</a> and <a href="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">privacy policy</a>.
        </p>
        <button type="button" onClick={onCancel} className="w-full cursor-pointer text-center text-xs text-foreground-600 hover:text-foreground-900">Not you? Sign out</button>
      </div>
    </form>
  );
}
