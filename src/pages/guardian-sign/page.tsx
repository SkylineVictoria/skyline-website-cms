import { useEffect, useState } from "react";
import { Button } from "@/pages/admin/components/ui";
import { DeclarationTicks } from "@/pages/agency/components/ApplicationHandoff";
import { guardianOpen, guardianSendCode, guardianSign, guardianVerify, type GuardianView } from "@/pages/agency/lib/handoff";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STORE = "slit-guardian-sign";

/**
 * APPLICATION-STUDENT-SIGNS (owner, 2026-11-25): the parent / guardian of a student under 18 opens the emailed link, gets a
 * one-time code by email, reads the same declarations and signs. No account; the application is submitted when they sign.
 */
export default function GuardianSignPage() {
  const [token, setToken] = useState("");
  const [view, setView] = useState<GuardianView | null>(null);
  const [step, setStep] = useState<"loading" | "invalid" | "code" | "sign" | "done">("loading");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [ticked, setTicked] = useState<{ value: Record<string, string>; complete: boolean }>({ value: {}, complete: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("t");
    let value = fromLink && TOKEN.test(fromLink) ? fromLink : "";
    try {
      if (value) sessionStorage.setItem(STORE, value); else value = sessionStorage.getItem(STORE) ?? "";
    } catch { /* storage unavailable: the link still works when opened again */ }
    if (fromLink !== null) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!TOKEN.test(value)) { setStep("invalid"); return; }
    setToken(value);
    guardianOpen(value).then((v) => { setView(v); setStep(v.verified ? "sign" : "code"); },
      (e: Error) => { setError(e.message); setStep("invalid"); });
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(false); }
  };
  const sendCode = () => run(async () => { await guardianSendCode(token); setCodeSent(true); });
  const verify = () => run(async () => {
    const result = await guardianVerify(token, code.trim());
    if (!result.ok) throw new Error(result.error ?? "That code is not right.");
    setStep("sign");
  });
  const sign = () => run(async () => { await guardianSign(token, ticked.value); setStep("done"); try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } });

  return (
    <main className="flex min-h-screen items-start justify-center bg-background-100 px-4 py-10">
      <section className="w-full max-w-2xl space-y-4 rounded-card border border-background-200 bg-background-50 p-6" data-testid="guardian-sign">
        <h1 className="font-heading text-xl font-semibold">Parent or guardian signature</h1>
        {step === "loading" ? <p role="status">Opening…</p> : null}
        {step === "invalid" ? <p>{error || "This link is invalid, expired, or no longer available."} Ask the student to send it to you again.</p> : null}
        {view && step !== "invalid" ? (
          <p className="text-sm text-foreground-700">
            {view.studentName}{view.reference ? ` (${view.reference})` : ""} is under 18 and has applied to study with SLIT. As their {view.relationship.toLowerCase() || "parent or guardian"},
            please read the declarations and sign. The application is submitted once you sign.
          </p>
        ) : null}
        {step === "code" && view ? (
          <div className="space-y-3">
            <p className="text-sm">To check it is you, we email a one-time code to {view.email}.</p>
            <Button variant={codeSent ? "outline" : "primary"} disabled={busy} onClick={() => void sendCode()}>{codeSent ? "Send another code" : "Email me a code"}</Button>
            {codeSent ? (
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void verify(); }}>
                <label className="text-sm">6-digit code
                  <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                    className="mt-1 block w-36 rounded-md border border-background-300 px-3 py-2 font-mono tracking-widest" data-testid="guardian-code" />
                </label>
                <Button type="submit" disabled={busy || code.length !== 6}>Check code</Button>
              </form>
            ) : null}
          </div>
        ) : null}
        {step === "sign" && view ? (
          <div className="space-y-4">
            <DeclarationTicks who="guardian" declarations={view.declarations} onChange={(value, complete) => setTicked({ value, complete })} />
            <p className="text-xs text-foreground-600">Signed electronically as {view.guardianName} ({view.relationship}). Your name, verified email, the date and time, this device and the exact text above are recorded.</p>
            <Button disabled={busy || !ticked.complete} onClick={() => void sign()} data-testid="guardian-sign-button">{busy ? "Signing…" : "Sign and submit the application"}</Button>
          </div>
        ) : null}
        {step === "done" ? (
          <p role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900">Thank you. You have signed, and the application has been submitted to SLIT. You can close this page.</p>
        ) : null}
        {error && step !== "invalid" ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      </section>
    </main>
  );
}
