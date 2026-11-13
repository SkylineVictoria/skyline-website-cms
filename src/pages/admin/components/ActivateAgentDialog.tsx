import { useEffect, useState } from "react";
import { Button, Field, Modal, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { activateAgent, listBusinesses, type ActivationResult, type BusinessRow, type BusinessStatus } from "@/pages/admin/lib/businessData";
import type { AgentToActivate } from "@/pages/admin/lib/agentActivation";
import { invokePortalUsers } from "@/pages/agency/lib/portalData";
import { portalPasswordResetUrl } from "@/pages/agency/lib/portalAuthContext";
import { PhoneInput } from "@/components/feature/applicationInputs";
import EmailField from "@/components/identity/EmailField";
import { emailTakenFrom, isEmailTakenError } from "@/lib/identity/email";
import { parseStoredPhone, validateStoredPhone } from "../../../../supabase/functions/_shared/validation/identifiers";

type Picked = { id: string; name: string; status: BusinessStatus | null } | null;

const EMAIL = /^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/;

/**
 * Add an agent to a business, or activate one, in one step: choose the business (activated too when it is inactive), confirm
 * name, email, phone and role, and optionally send the sign-in invitation. A new business is added from Businesses (ABN).
 */
export default function ActivateAgentDialog({ agent, open, onClose, onDone }: {
  agent: AgentToActivate | null; open: boolean; onClose: () => void; onDone: (result: ActivationResult) => void;
}) {
  const { push } = useToast();
  const adding = !agent?.agentId;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<"agent" | "agency_admin">("agent");
  const [picked, setPicked] = useState<Picked>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<BusinessRow[] | null>(null);
  const [invite, setInvite] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [emailError, setEmailError] = useState<unknown>(null);
  const [emailBlocking, setEmailBlocking] = useState(false);
  // Set when the agent was saved but the invitation's email was refused: a retry updates that agent instead of adding another,
  // and the list is refreshed when the dialog closes.
  const [saved, setSaved] = useState<ActivationResult | null>(null);
  const agentId = saved?.agentId ?? agent?.agentId ?? null;
  const close = () => {
    if (busy) return;
    if (saved) onDone(saved);
    onClose();
  };

  useEffect(() => {
    setEmailError(null);
    setSaved(null);
    if (!open) return;
    setName(agent?.name ?? "");
    setEmail(agent?.email ?? "");
    setPhone(agent?.phone ?? "");
    setRole(agent?.role === "agency_admin" ? "agency_admin" : "agent");
    setPicked(agent?.business ?? null);
    setSearch("");
    setInvite(true);
    setError("");
  }, [open, agent]);

  useEffect(() => {
    if (!open || picked) return;
    let active = true;
    const timer = window.setTimeout(() => {
      listBusinesses({ search, limit: 6, offset: 0 })
        .then((r) => { if (active) setResults(r.rows); })
        .catch(() => { if (active) setResults([]); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [open, picked, search]);

  const cleanEmail = email.trim().toLowerCase();
  const emailValid = !cleanEmail || EMAIL.test(cleanEmail);
  const willInvite = invite && !agent?.hasLogin && Boolean(cleanEmail) && emailValid;

  const submit = async () => {
    if (emailBlocking) return;
    setError("");
    setEmailError(null);
    if (!name.trim()) { setError("Enter the agent's name."); return; }
    if (!emailValid) { setError("Enter a valid email address, or leave it empty."); return; }
    if (!picked) { setError("Choose the business this agent works for."); return; }
    // The phone is optional; when a number is typed it must be valid for its country (10 digits from 0 in Australia).
    const cleanPhone = phone.trim();
    const hasNumber = Boolean(parseStoredPhone(cleanPhone)?.national);
    if (hasNumber) {
      const problem = validateStoredPhone(cleanPhone);
      if (problem) { setError(problem); return; }
    }
    const storedPhone = hasNumber ? cleanPhone : "";
    setBusy(true);
    try {
      // The MARN is no longer asked for; an agent's existing one is kept.
      const result = await activateAgent({ agentId, businessId: picked.id, name: name.trim(), email: cleanEmail, phone: storedPhone, marn: agent?.marn ?? "", role });
      let message = `${result.name} ${adding ? "added to" : "activated with"} ${result.businessName}.`;
      if (result.businessActivated) message += " The business was activated too.";
      if (willInvite && !result.hasLogin) {
        try {
          const sent = await invokePortalUsers({ action: "invite", email: result.email, name: result.name, role: result.role, agencyId: result.agencyId, redirectTo: portalPasswordResetUrl() });
          message += sent.warning ? ` ${String(sent.warning)}` : sent.emailSent ? ` A sign-in invitation was emailed to ${result.email}.` : " They can sign in with their existing account.";
        } catch (e) {
          // A pending invitation for this email (portal_invitation_create's own sentence, kept in the 409 details) is harmless.
          const reason = `${e instanceof Error ? e.message : ""} ${emailTakenFrom(e)?.details ?? ""}`.trim();
          // The agent is saved, but the invitation's email is refused (another agent / portal login has it): shown under the
          // field and the dialog stays open, so a different email can be tried for the same agent.
          if (!/already been invited/i.test(reason) && isEmailTakenError(e)) {
            setSaved(result);
            setEmailError(e);
            return;
          }
          message += /already been invited/i.test(reason) ? " An invitation is already waiting for this email; resend it from the business's Agents tab."
            : ` The invitation was not sent${reason ? `: ${reason}` : "."} You can invite them from the business's Agents tab.`;
        }
      } else if (!result.hasLogin) {
        message += " No invitation was sent.";
      }
      push(message);
      onDone(result);
      onClose();
    } catch (e) {
      if (isEmailTakenError(e)) { setEmailError(e); return; }
      setError(e instanceof Error ? e.message : "We could not activate this agent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} width="max-w-xl"
      title={adding ? "Add agent" : `Activate ${agent?.name || "agent"}`}
      footer={<>
        <Button variant="outline" disabled={busy} onClick={close}>Cancel</Button>
        <Button disabled={busy || emailBlocking} onClick={() => void submit()}>{busy ? (adding ? "Adding…" : "Activating…") : adding ? "Add agent" : "Activate agent"}</Button>
      </>}>
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-label font-medium text-foreground-800">Business <span className="text-primary-600">*</span></p>
          {picked ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-background-300 px-3 py-2.5">
              <span className="text-sm"><b className="text-foreground-900">{picked.name}</b>{picked.status && picked.status !== "Active" ? <span className="ml-2 text-xs text-foreground-500">Inactive</span> : null}</span>
              {!agent?.business || adding ? <Button size="sm" variant="ghost" onClick={() => setPicked(null)}>Change</Button> : null}
            </div>
          ) : (
            <div className="space-y-2">
              <TextInput autoFocus type="search" placeholder="Search business name, ABN, agent or MARN" value={search} onChange={(e) => setSearch(e.target.value)} />
              {results === null ? <p className="text-xs text-foreground-500">Searching…</p> : (
                <ul className="max-h-56 divide-y divide-background-200 overflow-y-auto rounded-md border border-background-200">
                  {results.map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => setPicked({ id: r.id, name: r.name, status: r.status })}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-background-100">
                        <span><b className="text-foreground-900">{r.name}</b>{r.abn ? <span className="ml-2 text-xs text-foreground-500">ABN {r.abn}</span> : null}</span>
                        <span className={`text-xs ${r.status === "Active" ? "text-emerald-700" : "text-foreground-500"}`}>{r.status}</span>
                      </button>
                    </li>
                  ))}
                  {results.length === 0 ? <li className="px-3 py-2 text-sm text-foreground-600">No business matches. Add it from Businesses with its ABN.</li> : null}
                </ul>
              )}
            </div>
          )}
          {picked && picked.status && picked.status !== "Active" ? (
            <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{picked.name} is inactive. It will be activated too.</p>
          ) : null}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Name" required><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Email" hint={agent?.hasLogin ? "They already have a login." : "Where the sign-in invitation goes."}>
            <EmailField value={email} onChange={setEmail} aria-invalid={!emailValid} kind="agent" context="admin"
              recordId={agentId} savedEmail={saved ? null : agent?.email ?? null} serverError={emailError}
              onStatusChange={(_status, blocking) => setEmailBlocking(blocking)} />
          </Field>
          <div className="sm:col-span-2">
            {/* The shared phone control: country code plus number, checked the same way as every other phone field. */}
            <p className="mb-1.5 text-label font-medium text-foreground-800">Phone</p>
            <div onInput={(e) => { const target = e.target as HTMLInputElement; if (target.name === "agent_phone") setPhone(target.value); }}>
              <PhoneInput key={open ? agent?.agentId ?? "new" : "closed"} id="add-agent-phone" name="agent_phone" value={phone} locked={busy} placeholder="041 234 5678" />
            </div>
            <p className="mt-1 text-xs text-foreground-500">Optional. Choose the country code, then the number, for example 041 234 5678.</p>
          </div>
        </div>

        <fieldset>
          <legend className="mb-1.5 text-label font-medium text-foreground-800">Role</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            <label className="flex items-center gap-2"><input type="radio" name="agent-role" checked={role === "agent"} onChange={() => setRole("agent")} /> Agent</label>
            <label className="flex items-center gap-2"><input type="radio" name="agent-role" checked={role === "agency_admin"} onChange={() => setRole("agency_admin")} /> Business admin agent <span className="text-xs text-foreground-500">(manages the business's agents)</span></label>
          </div>
        </fieldset>

        {!agent?.hasLogin ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={invite} disabled={!cleanEmail} onChange={(e) => setInvite(e.target.checked)} />
            <span>Send a sign-in invitation{cleanEmail ? ` to ${cleanEmail}` : ""}
              {!cleanEmail ? <span className="block text-xs text-foreground-500">Add an email to send an invitation. Without one, the agent is approved but cannot sign in yet.</span> : null}
            </span>
          </label>
        ) : null}

        {error ? <p role="alert" className="text-sm font-medium text-red-700">{error}</p> : null}
      </div>
    </Modal>
  );
}
