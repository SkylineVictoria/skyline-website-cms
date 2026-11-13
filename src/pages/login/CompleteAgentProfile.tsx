import { useState, type FormEvent } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { formatAbn, mobileProblem } from "@/lib/enrolForm";
import { readSignUpBusiness, rememberSignUpBusiness } from "@/lib/authProviders";
import AgentBusinessStep, { type ChosenBusiness } from "@/pages/login/AgentBusinessStep";
import ContactConflictPopup from "@/pages/login/ContactConflictPopup";
import { isContactConflict } from "@/lib/enrolForm";

/**
 * After an agent signs up with Google: the business they confirmed before leaving (or, when they started from the Sign in
 * tab, the same "find your business" step), their name and email from Google, and only their phone to add. The business
 * is created inactive and waits for SLIT's review; this account is its administrator once approved.
 */
export default function CompleteAgentProfile({ user, onDone }: { user: User; onDone: (businessName: string) => void }) {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const googleName = String(meta.full_name ?? meta.name ?? "").trim();
  const emailVerified = Boolean(user.email && user.email_confirmed_at);
  const [business, setBusiness] = useState<ChosenBusiness | null>(() => {
    const kept = readSignUpBusiness();
    return kept ? { abn: kept.abn, businessName: kept.businessName, details: null } : null;
  });
  const [contact, setContact] = useState(googleName);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState("");

  if (!business) {
    return (
      <div>
        <p className="mb-3 font-heading text-lg font-semibold text-foreground-950">Let's find your business</p>
        <AgentBusinessStep initial={null} onChosen={(chosen) => { setBusiness(chosen); rememberSignUpBusiness({ abn: chosen.abn, businessName: chosen.businessName, looked: Boolean(chosen.details) }); }} />
      </div>
    );
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const phone = String(new FormData(event.currentTarget).get("phone") ?? "");
    const next: Record<string, string> = {};
    if (contact.trim().length < 2) next.contact = "Enter your name.";
    const phoneError = mobileProblem(phone); if (phoneError) next.phone = phoneError.replace("mobile number", "phone number");
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await supabase.rpc("portal_self_register_agent_complete", {
      p_input: { abn: business.abn, businessName: business.businessName, contactName: contact.trim(), email: emailVerified ? String(user.email) : "", phone },
    });
    setBusy(false);
    if (error) {
      const message = error.message || "We could not submit your application. Please try again.";
      if (isContactConflict(message)) {
        setConflict(message);
        // The email comes from Google and cannot be changed here: an email clash means signing up with another account.
        setErrors(/phone/i.test(message) && !/email/i.test(message) ? { phone: "Already linked to another company." }
          : { form: "Your Google email is already linked to another company. Sign out and use a different Google account, or register with a company email instead." });
      } else setErrors({ form: message });
      return;
    }
    rememberSignUpBusiness(null);
    onDone(business.businessName);
  };

  const problem = (key: string) => (errors[key] ? <span className="mt-1 block text-xs text-primary-700" role="alert">{errors[key]}</span> : null);

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2.5 text-label text-amber-900" role="status">
        <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" /><span>Agent accounts are reviewed by our team before you can sign in.</span>
      </div>
      <div className="mt-5 space-y-4">
        <dl className="space-y-1.5 rounded-lg border border-background-300 bg-background-50 p-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-foreground-500">Business</dt>
            <dd className="text-right">
              <span className="font-semibold text-foreground-900">{business.businessName}</span>
              <span className="block text-xs text-foreground-600">ABN {formatAbn(business.abn)} · <button type="button" onClick={() => { setBusiness(null); rememberSignUpBusiness(null); }} className="cursor-pointer font-medium text-primary-700 hover:text-primary-800">Change</button></span>
            </dd>
          </div>
          {googleName ? <div className="flex justify-between gap-3"><dt className="text-foreground-500">Name</dt><dd className="font-semibold text-foreground-900">{googleName}</dd></div> : null}
          {emailVerified ? <div className="flex justify-between gap-3"><dt className="text-foreground-500">Email</dt><dd className="truncate font-semibold text-foreground-900">{user.email}</dd></div> : null}
        </dl>
        {googleName ? null : <Field label="Your name" required><TextInput value={contact} onChange={(e) => setContact(e.target.value)} autoComplete="name" />{problem("contact")}</Field>}
        <div>
          <label htmlFor="agent-phone" className="mb-1.5 block text-label font-medium text-foreground-800">Phone <span className="text-primary-600">*</span></label>
          <PhoneInput id="agent-phone" name="phone" required placeholder="041 234 5678" />
          {problem("phone")}
        </div>
        {errors.form ? <div className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-label text-primary-900" role="alert">{errors.form}</div> : null}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Submitting…" : "Submit application"}</Button>
        <p className="text-center text-xs text-foreground-500">
          By submitting you agree to the <a href="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">terms</a> and <a href="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">privacy policy</a>.
        </p>
      </div>
      <ContactConflictPopup message={conflict} onClose={() => setConflict("")} />
    </form>
  );
}
