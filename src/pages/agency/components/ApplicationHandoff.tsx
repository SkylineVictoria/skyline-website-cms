import { useEffect, useState, type ChangeEvent } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import {
  getDeclarations, getHandoffDiff, requestApplicationChange, sendGuardianRequest, takeBackApplication,
  HANDOFF_EVENT_LABEL, HANDOFF_STATE_LABEL, type Declaration, type Handoff, type HandoffDiff,
} from "@/pages/agency/lib/handoff";
import { sendApplicationInvitation } from "@/pages/agency/lib/portalApplications";
import { signingPasswordNeeded } from "@/pages/agency/lib/handoff";
import { passwordProblem } from "@/lib/passwords";

const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : "—");

/**
 * The declarations the student (or the parent / guardian) reads and ticks one by one. The texts come from the server, and what is
 * recorded is the hash of the exact text shown (onChange gets { key: hash } of the ticked ones; complete when every one is ticked).
 */
export function DeclarationTicks({ who, onChange, declarations: given }: {
  who: "student" | "guardian";
  onChange: (ticked: Record<string, string>, complete: boolean) => void;
  declarations?: Declaration[];
}) {
  const [declarations, setDeclarations] = useState<Declaration[]>(given ?? []);
  const [ticked, setTicked] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  useEffect(() => {
    if (given) { setDeclarations(given); return; }
    getDeclarations().then(setDeclarations, () => setError("The declarations could not be loaded. Reload the page."));
  }, [given]);
  const toggle = (d: Declaration, on: boolean) => {
    const next = { ...ticked };
    if (on) next[d.key] = d.hash; else delete next[d.key];
    setTicked(next);
    onChange(next, declarations.length > 0 && declarations.every((x) => next[x.key]));
  };
  if (error) return <p role="alert" className="text-sm text-red-800">{error}</p>;
  if (!declarations.length) return <p role="status" className="text-sm text-foreground-600">Loading the declarations…</p>;
  return (
    <div className="space-y-3" data-testid="declaration-ticks">
      {declarations.map((d) => (
        <div key={d.key} className="rounded-lg border border-background-200 bg-background-50 p-4">
          <p className="font-heading text-sm font-semibold text-foreground-950">{d.title}</p>
          <div className="mt-2 max-h-48 space-y-2 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-foreground-700">{d.body}</div>
          <label className="mt-3 flex items-start gap-3 text-sm text-foreground-900">
            <input type="checkbox" checked={Boolean(ticked[d.key])} onChange={(e) => toggle(d, e.target.checked)}
              className="mt-0.5 h-5 w-5 shrink-0 accent-primary-500" data-testid={`declaration-${d.key}`} />
            <span>{who === "student" ? "I have read and agree to this." : "As the parent or guardian, I have read and agree to this for the student."}</span>
          </label>
        </div>
      ))}
    </div>
  );
}

function Timeline({ handoff }: { handoff: Handoff }) {
  if (!handoff.events.length) return null;
  return (
    <ol className="space-y-1.5 border-l border-background-200 pl-4 text-sm" data-testid="handoff-timeline">
      {handoff.events.map((e, i) => (
        <li key={i} className="relative">
          <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-primary-500" aria-hidden="true" />
          <span className="font-medium text-foreground-900">{HANDOFF_EVENT_LABEL[e.event] ?? e.event}</span>
          <span className="text-foreground-500"> · {when(e.at)}{e.actorName ? ` · ${e.actorName}` : ""}</span>
          {e.event === "change_requested" && typeof e.detail?.note === "string" ? <p className="mt-0.5 rounded bg-amber-50 px-2 py-1 text-xs text-amber-900">“{e.detail.note}”</p> : null}
        </li>
      ))}
      {handoff.lastSavedAt && handoff.state === "with_student" ? <li className="text-foreground-500">Last saved by the student · {when(handoff.lastSavedAt)}</li> : null}
    </ol>
  );
}

const show = (value: unknown) => (value === null || value === undefined || value === "" ? "—" : Array.isArray(value) ? value.join(", ") : typeof value === "object" ? JSON.stringify(value) : String(value));

/** What the student changed: the application sent vs submitted (or the current draft while it is still with them). */
export function HandoffDiffView({ applicationId }: { applicationId: string }) {
  const [diff, setDiff] = useState<HandoffDiff | null>(null);
  useEffect(() => { getHandoffDiff(applicationId).then(setDiff, () => setDiff(null)); }, [applicationId]);
  if (!diff?.source) return null;
  return (
    <div className="space-y-2" data-testid="handoff-diff">
      <p className="text-sm font-semibold text-foreground-900">
        {diff.source === "submitted" ? "What the student changed before submitting" : "What the student has changed so far"} ({diff.changes.length})
      </p>
      {diff.changes.length ? (
        <div className="overflow-x-auto rounded-lg border border-background-200">
          <table className="w-full text-left text-xs">
            <thead className="bg-background-100 text-foreground-600"><tr><th className="px-3 py-2">Field</th><th className="px-3 py-2">You sent</th><th className="px-3 py-2">Student's answer</th><th className="px-3 py-2">Changed by</th></tr></thead>
            <tbody>{diff.changes.map((c) => (
              <tr key={c.field} className="border-t border-background-200">
                <td className="px-3 py-1.5 font-mono">{c.field}</td><td className="px-3 py-1.5 text-foreground-600 line-through">{show(c.before)}</td>
                <td className="px-3 py-1.5 font-medium text-foreground-900">{show(c.after)}</td><td className="px-3 py-1.5">Student</td>
              </tr>))}</tbody>
          </table>
        </div>
      ) : <p className="text-sm text-foreground-600">The student changed nothing.</p>}
    </div>
  );
}

/**
 * Agent / staff view of an application sent to the student: "With student", the timeline, Take back (before submit) and Resend.
 * Resend revokes the old link and sends a new one (the daily limit of the invitation rules applies).
 */
export function AgentHandoffPanel({ applicationId, handoff, onChanged }: { applicationId: string; handoff: Handoff; onChanged: () => void }) {
  const [busy, setBusy] = useState<"" | "take" | "resend">("");
  const [error, setError] = useState("");
  const [confirmTake, setConfirmTake] = useState(false);
  const run = async (kind: "take" | "resend") => {
    setBusy(kind); setError("");
    try {
      if (kind === "take") await takeBackApplication(applicationId);
      else await sendApplicationInvitation(applicationId);
      setConfirmTake(false);
      onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "That could not be done."); }
    finally { setBusy(""); }
  };
  if (!handoff.state) return null;
  const withStudent = handoff.state === "with_student" || handoff.state === "waiting_guardian";
  return (
    <section className="space-y-3 rounded-card border border-background-200 bg-background-50 p-5" data-testid="agent-handoff">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-heading text-lg font-semibold">Student review and signature</h2>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${withStudent ? "bg-sky-100 text-sky-900" : handoff.state === "change_requested" ? "bg-amber-100 text-amber-900" : handoff.state === "submitted" ? "bg-emerald-100 text-emerald-900" : "bg-background-200 text-foreground-800"}`}
          data-testid="handoff-state">{HANDOFF_STATE_LABEL[handoff.state]}</span>
      </div>
      {withStudent ? <p className="text-sm text-foreground-700">The student has the application: it is view-only for you until they sign or you take it back.
        {handoff.invite?.state === "expired" ? " Their link has expired: resend it." : ""}</p> : null}
      {handoff.state === "waiting_guardian" ? <p className="text-sm text-foreground-700">The student is under 18 and has signed. It is submitted once {handoff.guardian ? `${handoff.guardian.name} (${handoff.guardian.relationship})` : "their parent or guardian"} signs.</p> : null}
      {handoff.state === "change_requested" ? <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">The student asked for a change: “{handoff.changeNote}”. Make the change, then send it to the student again.</p> : null}
      <Timeline handoff={handoff} />
      {handoff.state === "submitted" || withStudent ? <HandoffDiffView applicationId={applicationId} /> : null}
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
      {withStudent ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={Boolean(busy)} onClick={() => setConfirmTake(true)} data-testid="handoff-take-back">Take back</Button>
          {handoff.state === "with_student" ? <Button variant="ghost" disabled={Boolean(busy)} onClick={() => void run("resend")} data-testid="handoff-resend">{busy === "resend" ? "Sending…" : "Resend link"}</Button> : null}
        </div>
      ) : null}
      <Modal open={confirmTake} title="Take the application back?" onClose={() => setConfirmTake(false)}
        footer={<><Button variant="ghost" onClick={() => setConfirmTake(false)}>Cancel</Button><Button disabled={busy === "take"} onClick={() => void run("take")}>{busy === "take" ? "Taking back…" : "Take back"}</Button></>}>
        <p className="text-sm text-foreground-700">The student's link stops working and they see “Your agent has taken this application back”. You can edit it again, then send it to them once more.
          {handoff.state === "waiting_guardian" ? " The student's signature and the parent / guardian's link are cancelled: both sign again." : ""}</p>
      </Modal>
    </section>
  );
}

/** Request a change (student): a note to the agent; the application goes back to them and is view-only until they send it again. */
export function RequestChangeButton({ applicationId, onDone, label = "Request a change" }: { applicationId: string; onDone: () => void; label?: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const send = async () => {
    setBusy(true); setError("");
    try { await requestApplicationChange(applicationId, note.trim()); setOpen(false); onDone(); }
    catch (e) { setError(e instanceof Error ? e.message : "The request could not be sent."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-primary-700 hover:underline" data-testid="request-change">
        <i className="ri-chat-forward-line" aria-hidden="true" /> {label}
      </button>
      <Modal open={open} title="Request a change" onClose={() => setOpen(false)}
        footer={<><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy || note.trim().length < 3} onClick={() => void send()}>{busy ? "Sending…" : "Send to my agent"}</Button></>}>
        <label className="block text-sm" htmlFor="request-change-note">What should your agent change? (for example the course, intake or fees)</label>
        <textarea id="request-change-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={4}
          className="mt-2 w-full rounded-md border border-background-300 px-3 py-2 text-sm" />
        <p className="mt-2 text-xs text-foreground-600">Your application goes back to your agent and is view-only for you until they send it again. What you saved is kept.</p>
        {error ? <p role="alert" className="mt-2 text-sm text-red-800">{error}</p> : null}
      </Modal>
    </>
  );
}

/** The student under 18 names a parent / guardian, who gets an email link to verify and sign. */
export function GuardianRequestForm({ applicationId, handoff, onSent }: { applicationId: string; handoff: Handoff | null; onSent: () => void }) {
  const [form, setForm] = useState({ name: "", relationship: "", email: "", mobile: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const guardian = handoff?.guardian;
  const set = (key: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });
  const send = async () => {
    setBusy(true); setError("");
    try { await sendGuardianRequest(applicationId, form); setSent(true); onSent(); }
    catch (e) { setError(e instanceof Error ? e.message : "The email could not be sent."); }
    finally { setBusy(false); }
  };
  const input = "mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-sm";
  return (
    <section className="space-y-3 rounded-card border border-sky-200 bg-sky-50/60 p-5" data-testid="guardian-request">
      <h2 className="font-heading text-lg font-semibold">Waiting for your parent or guardian</h2>
      <p className="text-sm text-foreground-700">You are under 18, so a parent or guardian signs too. Your application is submitted once they have signed.</p>
      {guardian && guardian.state !== "failed" && guardian.state !== "revoked" ? (
        <p className="text-sm text-foreground-800">We emailed {guardian.name} ({guardian.relationship}) at {guardian.email}{guardian.sentAt ? ` on ${when(guardian.sentAt)}` : ""}.
          {guardian.state === "expired" ? " The link has expired: send it again below." : " You can send it again below, for example to another address."}</p>
      ) : null}
      {sent ? <p role="status" className="text-sm font-medium text-emerald-800">Sent. Ask them to check their email.</p> : null}
      <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <label className="text-sm">Parent or guardian's full name<input required value={form.name} onChange={set("name")} className={input} maxLength={120} /></label>
        <label className="text-sm">Relationship to you<input required value={form.relationship} onChange={set("relationship")} placeholder="Mother, father, legal guardian…" className={input} maxLength={60} /></label>
        <label className="text-sm">Their email<input required type="email" value={form.email} onChange={set("email")} className={input} maxLength={254} /></label>
        <label className="text-sm">Their mobile<input required type="tel" value={form.mobile} onChange={set("mobile")} className={input} maxLength={20} /></label>
        <div className="sm:col-span-2"><Button type="submit" disabled={busy}>{busy ? "Sending…" : guardian ? "Send again" : "Send to my parent or guardian"}</Button></div>
      </form>
      {error ? <p role="alert" className="text-sm text-red-800">{error}</p> : null}
    </section>
  );
}

/** What a student sees when the application is not theirs to edit right now. Returns null when they may continue. */
export function StudentHandoffNotice({ applicationId, handoff, onChanged }: { applicationId: string; handoff: Handoff | null; onChanged: () => void }) {
  if (!handoff?.state || handoff.state === "with_student" || handoff.state === "submitted") return null;
  if (handoff.state === "waiting_guardian") return <GuardianRequestForm applicationId={applicationId} handoff={handoff} onSent={onChanged} />;
  return (
    <section className="space-y-2 rounded-card border border-amber-200 bg-amber-50/70 p-5" data-testid="student-handoff-notice">
      <h2 className="font-heading text-lg font-semibold">{handoff.state === "change_requested" ? "Waiting for your agent" : "Your agent has taken this application back"}</h2>
      <p className="text-sm text-foreground-700">
        {handoff.state === "change_requested"
          ? <>You asked: “{handoff.changeNote}”. Your agent will make the change and send the application back to you. Until then it is view-only.</>
          : <>Your agent is making changes. You will get an email when it is ready for you again. What you saved is kept, and anything you had not saved stays on this device as a draft.</>}
      </p>
    </section>
  );
}

/** The password a guest student creates when signing (needed: the account has no password or Google yet). */
export interface SignPassword { needed: boolean; password: string; valid: boolean }

/**
 * APPLICATION-INVITE-GUEST-START (owner, 2026-11-26): a student who opened the application from the link alone creates their
 * password at the signature, so they can sign in to their SLIT account later. Shows nothing once the student has made their own password (or uses Google, or has submitted before).
 */
export function SignPasswordFields({ applicationId, onChange }: { applicationId: string; onChange: (value: SignPassword) => void }) {
  const [needed, setNeeded] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  useEffect(() => {
    let live = true;
    void signingPasswordNeeded(applicationId).then((need) => { if (live) { setNeeded(need); onChange({ needed: need, password: "", valid: !need }); } });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- checked once
  }, []);
  if (!needed) return null;
  const update = (next: string, again: string) => {
    setPassword(next); setConfirm(again);
    onChange({ needed: true, password: next, valid: !passwordProblem(next, again) });
  };
  const input = "mt-1 w-full rounded-md border border-background-300 px-3 py-2 text-sm";
  return (
    <div className="space-y-2 rounded-lg border border-primary-200 bg-primary-50/40 p-4" data-testid="sign-password">
      <p className="text-sm font-semibold text-foreground-900">Create your password</p>
      <p className="text-xs text-foreground-600">You will use it to sign in to your SLIT account to follow your application.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Password<input type={show ? "text" : "password"} autoComplete="new-password" value={password} onChange={(e) => update(e.target.value, confirm)} className={input} data-testid="sign-password-new" /></label>
        <label className="text-sm">Confirm password<input type={show ? "text" : "password"} autoComplete="new-password" value={confirm} onChange={(e) => update(password, e.target.value)} className={input} data-testid="sign-password-confirm" /></label>
      </div>
      {password ? <p className="text-xs text-foreground-600">{passwordProblem(password, confirm || undefined) ?? "Looks good."}</p> : null}
      <label className="flex items-center gap-2 text-xs text-foreground-600"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} className="h-4 w-4" />Show password</label>
    </div>
  );
}
