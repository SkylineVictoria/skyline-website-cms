import { useEffect, useState } from "react";
import { Button, Field, TextInput } from "@/pages/admin/components/ui";
import { supabase } from "@/pages/admin/lib/supabase";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const STORE = "slit-text-invite";


async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("cms-admin-users", { body });
  if (error) {
    const detail = error.context instanceof Response ? await error.context.json().catch(() => null) : null;
    throw new Error(detail?.error ?? "That did not work. Try again.");
  }
  return data as T;
}

/**
 * CONTACT-VERIFY (owner, 2026-11-26): /admin/text-invite#t= — a CMS invitation opened from the text message. The text proved the
 * mobile; the person confirms their email with a 6-digit code, then goes on to create their password (a one-time link).
 */
export default function TextInvitePage() {
  const [token, setToken] = useState("");
  const [step, setStep] = useState<"loading" | "invalid" | "code" | "going">("loading");
  const [name, setName] = useState("");
  const [emailTo, setEmailTo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.hash.slice(1)).get("t");
    let value = fromLink && TOKEN.test(fromLink) ? fromLink : "";
    try { if (value) sessionStorage.setItem(STORE, value); else value = sessionStorage.getItem(STORE) ?? ""; } catch { /* storage unavailable */ }
    if (fromLink !== null) window.history.replaceState(window.history.state, "", window.location.pathname);
    if (!TOKEN.test(value)) { setStep("invalid"); return; }
    setToken(value);
    call<{ name: string; emailTo: string | null; emailPending: boolean }>({ action: "text_open", token: value })
      .then((v) => { setName(v.name); setEmailTo(v.emailTo); setStep("code"); }, (e: Error) => { setError(e.message); setStep("invalid"); });
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(false); }
  };
  const send = () => run(async () => { await call({ action: "text_code_send", token }); setSent(true); });
  const verify = () => run(async () => {
    const r = await call<{ ok: boolean; link?: string; reason?: string; error?: string }>({ action: "text_code_verify", token, code });
    if (r.ok && r.link) { setStep("going"); try { sessionStorage.removeItem(STORE); } catch { /* ignore */ } window.location.assign(r.link); return; }
    setCode("");
    setError(r.reason === "locked" ? "Too many wrong codes. Ask for a new code." : r.reason === "expired" ? "That code has expired. Ask for a new code." : r.error ?? "That code is not right.");
    if (r.reason !== "wrong") setSent(false);
  });

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5 py-10">
      <main className="w-full max-w-sm rounded-card bg-background-50 p-7 shadow-sm" aria-live="polite" data-testid="text-invite">
        {step === "loading" && <p className="text-center text-sm text-foreground-600">Checking your link…</p>}
        {step === "invalid" && <>
          <h1 className="font-heading text-xl font-bold text-foreground-950">This link cannot be used</h1>
          <p className="mt-2 text-sm text-foreground-700">{error || "The link has expired or was already used. Use the invitation we emailed you, or ask an administrator for a new one."}</p>
        </>}
        {step === "going" && <p className="text-center text-sm text-foreground-600">Email confirmed. Opening the page to create your password…</p>}
        {step === "code" && <>
          <h1 className="font-heading text-2xl font-bold text-foreground-950">Welcome{name ? `, ${name}` : ""}</h1>
          <p className="mt-2 text-sm text-foreground-600">You opened your invitation from our text message, which confirmed your mobile. Confirm your email with a code, then create your password.</p>
          <div className="mt-5 space-y-3">
            {!sent ? <Button type="button" disabled={busy} onClick={() => void send()} data-testid="text-invite-send">{busy ? "Sending…" : `Email a code to ${emailTo || "my email"}`}</Button>
              : <>
                <p className="text-sm text-foreground-700">We emailed a 6-digit code to {emailTo || "your email"}. It works for 10 minutes.</p>
                <Field label="6-digit code"><TextInput value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                  className="!text-base tracking-widest" data-testid="text-invite-code" /></Field>
                <div className="flex flex-wrap items-center gap-3">
                  <Button type="button" disabled={busy || code.length !== 6} onClick={() => void verify()} data-testid="text-invite-verify">{busy ? "Checking…" : "Confirm and continue"}</Button>
                  <button type="button" className="text-sm underline" disabled={busy} onClick={() => void send()}>Send a new code</button>
                </div>
              </>}
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          </div>
        </>}
      </main>
    </div>
  );
}
