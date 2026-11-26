import { useEffect, useState } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { contactCode, onContact, type ContactState } from "@/lib/staffOnboardingApi";

/**
 * CONTACT-VERIFY (2026-11-26): shown on an employee link opened from the text message. The text proved the mobile; the email is
 * confirmed with a 6-digit code before the password, the documents or the signature (the function refuses them until then).
 */
export default function EmailCodeGate({ token }: { token: string | null }) {
  const [state, setState] = useState<ContactState | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [problem, setProblem] = useState("");
  useEffect(() => onContact(setState), []);
  if (!token || !state?.emailPending) return null;
  const send = async () => {
    setBusy(true); setProblem(""); setNote("");
    try { await contactCode.send(token); setSent(true); setNote(`We emailed a 6-digit code to ${state.emailTo || "your email"}. It works for 10 minutes.`); }
    catch (e) { setProblem(e instanceof Error ? e.message : "A code could not be sent."); } finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setProblem("");
    try {
      const r = await contactCode.verify(token, code);
      if (r.ok) { setNote(""); return; }
      setCode("");
      setProblem(r.reason === "wrong" ? `That code is not right. ${r.remaining ?? 0} attempt${r.remaining === 1 ? "" : "s"} left.`
        : r.reason === "locked" ? "Too many wrong codes. Ask for a new code." : "That code has expired. Ask for a new code.");
      if (r.reason !== "wrong") setSent(false);
    } catch (e) { setProblem(e instanceof Error ? e.message : "The code could not be checked."); } finally { setBusy(false); }
  };
  return (
    <fieldset className="mb-4 space-y-3 rounded-lg border border-secondary-200 bg-secondary-50 p-4" data-testid="staff-email-code">
      <legend className="px-1 text-sm font-semibold text-foreground-900">Confirm your email</legend>
      <p className="text-sm text-foreground-700">You opened this link from our text message, which confirmed your mobile. Confirm your email too: we send a code to {state.emailTo || "your email"}.</p>
      {!sent ? <Button type="button" variant="outline" disabled={busy} onClick={() => void send()} data-testid="staff-email-code-send">{busy ? "Sending…" : "Email me a code"}</Button>
        : <div className="flex flex-wrap items-end gap-2">
          <Field label="6-digit code"><TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            className="!w-36 !text-base tracking-widest" data-testid="staff-email-code-input" /></Field>
          <Button type="button" disabled={busy || code.length !== 6} onClick={() => void verify()} data-testid="staff-email-code-verify">{busy ? "Checking…" : "Confirm"}</Button>
          <button type="button" className="mb-2 text-sm underline" disabled={busy} onClick={() => void send()}>Send a new code</button>
        </div>}
      {note && <p role="status" className="text-sm text-foreground-700">{note}</p>}
      {problem && <p role="alert" className="text-sm text-red-700">{problem}</p>}
    </fieldset>
  );
}
