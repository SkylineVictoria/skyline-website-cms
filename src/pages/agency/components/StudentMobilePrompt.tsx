import { useEffect, useState, type FormEvent } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { mobileProblem } from "@/lib/enrolForm";

/**
 * A signed-in student whose student record has no mobile (for example an account made with Google before the mobile was
 * asked, or one set up by staff) must add one before using the portal. Shown once; nothing else on the page is usable meanwhile.
 */
export default function StudentMobilePrompt({ onSignOut }: { onSignOut: () => void }) {
  const [needed, setNeeded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void supabase.rpc("portal_student_needs_mobile").then(({ data }) => { if (active && data === true) setNeeded(true); });
    return () => { active = false; };
  }, []);

  if (!needed) return null;

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const mobile = String(new FormData(event.currentTarget).get("student-mobile") ?? "").trim();
    const problem = mobileProblem(mobile);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError("");
    const { error: saveError } = await supabase.rpc("portal_student_set_mobile", { p_phone: mobile });
    setBusy(false);
    if (saveError) { setError(saveError.message || "We could not save your mobile number. Try again."); return; }
    setNeeded(false);
  };

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-foreground-950/50 p-4" role="dialog" aria-modal="true" aria-labelledby="student-mobile-title" data-testid="student-mobile-prompt">
      <form onSubmit={(event) => void save(event)} noValidate className="w-full max-w-md rounded-lg bg-background-50 p-6 shadow-xl">
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-700">
          <i className="ri-smartphone-line" aria-hidden="true" />
        </span>
        <h2 id="student-mobile-title" className="mt-4 font-heading text-lg font-bold text-foreground-950">Add your mobile number</h2>
        <p className="mt-1.5 text-sm text-foreground-600">
          We need your mobile number to contact you about your application. Choose your country code, then enter the number.
        </p>
        <div className="mt-4">
          <label htmlFor="student-mobile" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
          <PhoneInput id="student-mobile" name="student-mobile" required placeholder="041 234 5678" />
          {error ? <span className="mt-1 block text-xs text-primary-700" role="alert">{error}</span> : null}
        </div>
        <button type="submit" disabled={busy}
          className="mt-5 inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-md bg-primary-500 px-4 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-60">
          {busy ? "Saving…" : "Save and continue"}
        </button>
        <button type="button" onClick={onSignOut} className="mt-3 w-full cursor-pointer text-center text-xs text-foreground-600 hover:text-foreground-900">Not now, sign me out</button>
      </form>
    </div>
  );
}
