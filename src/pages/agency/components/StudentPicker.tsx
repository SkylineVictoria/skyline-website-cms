import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";
import SearchPick, { type PickOption } from "@/pages/admin/components/SearchPick";
import AgentStatusBadge from "@/pages/admin/components/AgentStatusBadge";
import AddStudentRecordDialog, { type AddStudentRecordValue } from "@/pages/admin/components/AddStudentRecordDialog";
import { activateAgent, listBusinesses, setBusinessStatus, type BusinessStatus } from "@/pages/admin/lib/businessData";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { textableMobile } from "@/lib/textableMobile";
import { isEmailTakenError, normalizeEmail } from "@/lib/identity/email";
import { prefillFromSearch } from "@/pages/agency/lib/studentPicker";
import { validateEmail } from "@/pages/agency/lib/userValidation";
import {
  agentPickable, findAgentByProfile, findStudentByEmail, listActiveAgentsElsewhere, listAgentsOfBusiness, saveStudent, searchStudents,
  type BusinessAgentOption, type StudentPick,
} from "@/pages/agency/lib/portalApplications";

type Business = { id: string; name: string; status: BusinessStatus };
export type PickerRole = "slit_admin" | "agency_admin" | "agent";

/**
 * STUDENT-PICKER (owner 2026-11-27): "New student application" starts by picking the student. Typing 2+ characters searches the
 * students the caller may see (portal_student_search: SLIT staff every student, agency users their agency only) by name, email,
 * student ID, mobile or passport number; the last row, always there, adds a new student in a popup (a full-screen sheet on a phone).
 */
export default function StudentPicker({ value, onChange, role, agency, profileId, disabled }: {
  value: StudentPick | null;
  onChange: (student: StudentPick | null) => void;
  role: PickerRole;
  /** The signed-in agency user's own business (agency admin / agent). */
  agency: { id: string; name: string } | null;
  profileId: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<StudentPick[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const typed = q.trim();

  useEffect(() => {
    if (!open || typed.length < 2) { setRows([]); setLoading(false); setFailed(false); return; }
    let live = true;
    setLoading(true);
    setFailed(false);
    const timer = window.setTimeout(() => {
      searchStudents(typed)
        .then((found) => { if (live) { setRows(found); setActive(0); } })
        .catch(() => { if (live) { setRows([]); setFailed(true); } })
        .finally(() => { if (live) setLoading(false); });
    }, 220);
    return () => { live = false; window.clearTimeout(timer); };
  }, [typed, open]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const count = rows.length + 1; // the last row is always "+ Add new student"
  const choose = (index: number) => {
    if (index < rows.length) {
      const row = rows[index];
      if (!row.canStart) return;
      onChange(row);
      setQ("");
      setOpen(false);
    } else {
      setAdding(typed);
      setOpen(false);
    }
  };

  if (value) {
    return (
      <div data-testid="student-picked">
        <p className="mb-1.5 text-sm font-medium text-foreground-800">Student</p>
        <div className="flex items-start justify-between gap-3 rounded-md border border-background-300 bg-background-50 px-3 py-2.5">
          <dl className="grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
            <dt className="sr-only">Name</dt>
            <dd className="col-span-2 truncate font-semibold text-foreground-950">{value.name || "Unnamed student"}</dd>
            <dt className="text-foreground-500">Email</dt><dd className="truncate text-foreground-800">{value.email || "—"}</dd>
            <dt className="text-foreground-500">Student ID</dt><dd className="truncate text-foreground-800">{value.studentNumber || "Not given yet"}</dd>
            {value.phone ? <><dt className="text-foreground-500">Mobile</dt><dd className="truncate text-foreground-800">{value.phone}</dd></> : null}
            {value.dateOfBirth ? <><dt className="text-foreground-500">Date of birth</dt><dd className="truncate text-foreground-800">{value.dateOfBirth}</dd></> : null}
            {value.businessName || value.agentName ? <><dt className="text-foreground-500">Agent</dt><dd className="truncate text-foreground-800">{[value.agentName, value.businessName].filter(Boolean).join(", ")}</dd></> : null}
            {value.applications ? <><dt className="text-foreground-500">Applications</dt><dd className="text-foreground-800">{value.applications}</dd></> : null}
          </dl>
          <button type="button" disabled={disabled} onClick={() => onChange(null)} data-testid="student-change"
            className="shrink-0 rounded px-2 py-1 text-sm font-medium text-primary-700 hover:bg-background-100 disabled:opacity-60">Change</button>
        </div>
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative w-full">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-foreground-800">Student</label>
      <div className="relative">
        <i className="ri-search-line pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-foreground-400" aria-hidden="true" />
        <input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" autoFocus
          data-testid="student-search" disabled={disabled} value={q} autoComplete="off"
          placeholder="Search name, email, student ID, mobile or passport"
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, count - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter" && open) { e.preventDefault(); choose(active); }
            else if (e.key === "Escape") setOpen(false);
          }}
          className="w-full rounded-md border border-background-300 bg-background-50 py-2.5 pl-9 pr-3 text-sm text-foreground-950 placeholder:text-foreground-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40 disabled:bg-background-100" />
      </div>
      {open && !disabled ? (
        <ul id={`${id}-list`} role="listbox" data-testid="student-results"
          className="mt-1 max-h-80 w-full overflow-y-auto rounded-md border border-background-200 bg-background-50 py-1 shadow-sm">
          {typed.length < 2 ? <li className="px-3 py-2.5 text-sm text-foreground-500">Type at least 2 characters to search.</li> : null}
          {typed.length >= 2 && loading && rows.length === 0 ? <li className="px-3 py-2.5 text-sm text-foreground-500">Searching…</li> : null}
          {failed ? <li className="px-3 py-2.5 text-sm text-red-700">The search did not work. Try again.</li> : null}
          {typed.length >= 2 && !loading && !failed && rows.length === 0 ? <li className="px-3 py-2.5 text-sm text-foreground-500">No student matches “{typed}”.</li> : null}
          {rows.map((row, i) => (
            <li key={row.id} role="option" aria-selected={i === active} aria-disabled={!row.canStart} data-testid="student-result"
              onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); choose(i); }}
              className={`px-3 py-2 ${row.canStart ? "cursor-pointer" : "cursor-not-allowed opacity-60"} ${i === active ? "bg-primary-50" : ""}`}>
              <span className="block truncate text-sm font-medium text-foreground-900">{row.name || "Unnamed student"}</span>
              <span className="block truncate text-xs text-foreground-500">
                {[row.email, row.studentNumber ? `ID ${row.studentNumber}` : "No student ID yet"].filter(Boolean).join(" · ")}
              </span>
              {!row.canStart ? <span className="block truncate text-xs text-foreground-500">Looked after by {row.agentName || "another agent"}: ask your business admin agent.</span> : null}
            </li>
          ))}
          <li role="option" aria-selected={active === rows.length} data-testid="student-add-new"
            onMouseEnter={() => setActive(rows.length)} onMouseDown={(e) => { e.preventDefault(); choose(rows.length); }}
            className={`flex cursor-pointer items-center gap-2 border-t border-background-200 px-3 py-2.5 text-sm font-semibold text-primary-700 ${active === rows.length ? "bg-primary-50" : ""}`}>
            <i className="ri-add-line" aria-hidden="true" />Add new student
          </li>
        </ul>
      ) : null}
      <NewStudentSheet open={adding !== null} typed={adding ?? ""} role={role} agency={agency} profileId={profileId}
        onClose={() => setAdding(null)}
        onSaved={(student) => { setAdding(null); setQ(""); onChange(student); }} />
    </div>
  );
}

function NewStudentSheet({ open, typed, role, agency, profileId, onClose, onSaved }: {
  open: boolean;
  typed: string;
  role: PickerRole;
  agency: { id: string; name: string } | null;
  profileId: string | null;
  onClose: () => void;
  onSaved: (student: StudentPick) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [mobile, setMobile] = useState("");
  const [business, setBusiness] = useState<Business | null>(null);
  const [agent, setAgent] = useState<BusinessAgentOption | null>(null);
  const [recordDialogMode, setRecordDialogMode] = useState<"business" | "agent" | null>(null);
  const [initialAgentName, setInitialAgentName] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [field, setField] = useState<Record<string, string>>({});
  /** Email already used by a student: the one the caller may pick instead (null = a student they cannot see). */
  const [inUse, setInUse] = useState<{ student: StudentPick | null } | null>(null);

  useEffect(() => {
    if (!open) return;
    const p = prefillFromSearch(typed);
    setFirstName(p.firstName); setLastName(p.lastName); setEmail(p.email);
    setMobile("");
    setProblem(""); setField({}); setInUse(null); setRecordDialogMode(null);
    setBusiness(role === "slit_admin" ? null : agency ? { id: agency.id, name: agency.name, status: "Active" } : null);
    setAgent(null);
    // The agency user filling the form looks after the student unless they pick another agent of their business.
    if (role !== "slit_admin" && profileId) {
      void findAgentByProfile(profileId).then((own) => { if (own && agentPickable(own)) setAgent(own); }).catch(() => undefined);
    }
  }, [open, typed, role, agency, profileId]);

  const businessId = business?.id ?? "";
  const searchBusinesses = useCallback(async (query: string): Promise<PickOption[]> => {
    const result = await listBusinesses({ search: query, status: "Active", limit: 8, offset: 0 });
    return result.rows.map((row) => ({ id: row.id, label: row.name, meta: [row.abn ? `ABN ${row.abn}` : "", `${row.agents} agent${row.agents === 1 ? "" : "s"}`].filter(Boolean).join(", "), raw: row })) as PickOption[];
  }, []);
  const searchAgents = useCallback(async (query: string): Promise<PickOption[]> => {
    if (!businessId) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (text: string) => words.every((w) => text.toLowerCase().includes(w));
    const roleWord = (a: BusinessAgentOption) => a.role === "agency_admin" ? "Business admin agent" : "Agent";
    const own = (await listAgentsOfBusiness(businessId)).filter(agentPickable).filter((a) => hit(`${a.name} ${a.email} ${roleWord(a)}`))
      .map((a) => ({ id: a.id, label: a.name, meta: [a.email, roleWord(a)].filter(Boolean).join(", "), tag: <AgentStatusBadge status={a.status} />, raw: a }));
    const others = role === "slit_admin" ? (await listActiveAgentsElsewhere(businessId).catch(() => []))
      .filter((o) => hit(`${o.agent.name} ${o.agent.email} ${o.business.name}`))
      .map((o) => ({ id: `other:${o.agent.id}`, label: o.agent.name, meta: [o.agent.email, `${roleWord(o.agent)} at ${o.business.name}`].join(", "),
        tag: <AgentStatusBadge status={o.agent.status} />, raw: { ...o.agent, otherBusiness: o.business } })) : [];
    return [...own, ...others] as PickOption[];
  }, [businessId, role]);

  const showInUse = async (address: string) => {
    const found = await searchStudents(address, 5).catch(() => []);
    const same = found.find((row) => normalizeEmail(row.email) === address) ?? null;
    setInUse({ student: same });
    setField((f) => ({ ...f, email: "Email already in use." }));
  };

  const save = async () => {
    if (busy) return;
    const address = normalizeEmail(email);
    const errors: Record<string, string> = {};
    if (!firstName.trim()) errors.firstName = "Enter the first name.";
    if (!lastName.trim()) errors.lastName = "Enter the last name.";
    const emailIssue = validateEmail(address);
    if (emailIssue) errors.email = emailIssue;
    if (!agent) errors.agent = role === "slit_admin" ? "Choose the business and the agent who looks after the student." : "Choose the agent who looks after the student.";
    setField(errors);
    setInUse(null);
    setProblem("");
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const lookup = await findStudentByEmail(address);
      if (lookup.status !== "free") { await showInUse(address); return; }
      if (business && business.status !== "Active") await setBusinessStatus(business.id, "Active");
      if (business && agent!.status === "Inactive") await activateAgent({ agentId: agent!.id, businessId: business.id, name: agent!.name, email: agent!.email, role: agent!.role });
      const saved = await saveStudent({
        agentId: agent!.id, fullName: `${firstName.trim()} ${lastName.trim()}`, firstName: firstName.trim(), lastName: lastName.trim(),
        email: address, mobile,
      });
      const [row] = await searchStudents(saved.email || address, 5).then((found) => found.filter((r) => r.id === saved.id)).catch(() => []);
      onSaved(row ?? {
        id: saved.id, name: saved.name, email: saved.email || address, studentNumber: "", phone: saved.phone || mobile, dateOfBirth: "",
        businessId: saved.businessId, businessName: business?.name ?? "", agentId: saved.agentId, agentName: agent!.name, applications: 0, canStart: true,
      });
    } catch (e) {
      if (isEmailTakenError(e)) { await showInUse(address); return; }
      setProblem(e instanceof Error ? e.message : "The student could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const input = (invalid: boolean) => `w-full rounded-md border bg-background-50 px-3 py-2.5 text-sm text-foreground-950 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40 ${invalid ? "border-primary-600" : "border-background-300"}`;
  const err = (key: string) => field[key] ? <p role="alert" className="mt-1 text-xs text-primary-700">{field[key]}</p> : null;
  const chip = (title: string, sub: string, onChangeClick: () => void) => (
    <div className="flex items-center justify-between gap-3 rounded-md border border-background-300 bg-background-50 px-3 py-2.5">
      <span className="min-w-0"><b className="block truncate text-sm text-foreground-900">{title}</b><span className="block truncate text-xs text-foreground-500">{sub}</span></span>
      <button type="button" disabled={busy} onClick={onChangeClick} className="rounded px-2 py-1 text-sm font-medium text-primary-700 hover:bg-background-100 disabled:opacity-60">Change</button>
    </div>
  );

  const saveNewRecord = (value: AddStudentRecordValue) => {
    setRecordDialogMode(null);
    if (value.kind === "business") { setBusiness({ id: value.business.agencyId, name: value.business.name, status: "Active" }); setAgent(null); }
    else setAgent({ id: value.agent.agentId, profileId: null, name: value.agent.name, email: value.agent.email, role: value.agent.role, status: "Invited" });
  };

  return (
    <>
      <Modal open={open} title="Add new student" onClose={() => { if (!busy) onClose(); }} keepOpen sheet width="max-w-lg"
        footer={<>
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button icon="ri-user-add-line" disabled={busy} onClick={() => void save()} data-testid="new-student-save">{busy ? "Saving…" : "Save student"}</Button>
        </>}>
        <form noValidate className="space-y-4" data-testid="new-student-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="new-student-first" className="mb-1.5 block text-sm font-medium">First name <span className="text-primary-600">*</span></label>
              <input id="new-student-first" value={firstName} maxLength={100} autoFocus autoComplete="off" className={input(Boolean(field.firstName))}
                onChange={(e) => { setFirstName(e.target.value); setField((f) => ({ ...f, firstName: "" })); }} />
              {err("firstName")}
            </div>
            <div>
              <label htmlFor="new-student-last" className="mb-1.5 block text-sm font-medium">Last name <span className="text-primary-600">*</span></label>
              <input id="new-student-last" value={lastName} maxLength={100} autoComplete="off" className={input(Boolean(field.lastName))}
                onChange={(e) => { setLastName(e.target.value); setField((f) => ({ ...f, lastName: "" })); }} />
              {err("lastName")}
            </div>
          </div>
          <div>
            <label htmlFor="new-student-email" className="mb-1.5 block text-sm font-medium">Email <span className="text-primary-600">*</span></label>
            <input id="new-student-email" type="email" value={email} maxLength={254} autoComplete="off" className={input(Boolean(field.email))}
              onChange={(e) => { setEmail(e.target.value); setField((f) => ({ ...f, email: "" })); setInUse(null); }} />
            {err("email")}
            {inUse ? (
              <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="new-student-in-use">
                {inUse.student ? (
                  <>
                    <p>{inUse.student.name || "A student"} already uses this email{inUse.student.studentNumber ? ` (ID ${inUse.student.studentNumber})` : ""}.</p>
                    {inUse.student.canStart ? (
                      <button type="button" onClick={() => onSaved(inUse.student!)} data-testid="new-student-use-existing"
                        className="mt-1 font-semibold text-primary-700 underline">Select {inUse.student.name || "this student"} instead</button>
                    ) : <p className="mt-1">They are looked after by {inUse.student.agentName || "another agent"}: ask your business admin agent.</p>}
                  </>
                ) : <p>Another student already uses this email. Ask SLIT Administration if this is the same student.</p>}
              </div>
            ) : null}
          </div>
          {/* PHONE-HIDDEN (owner 2026-11-28): a student's mobile is optional and not asked when adding a student. */}
          {role === "agent" ? null : (
            <div className="space-y-3 border-t border-background-200 pt-4">
              <p className="text-sm font-medium text-foreground-800">Who looks after this student?</p>
              {role === "slit_admin" ? (business ? chip(business.name, business.status === "Active" ? "Business" : "Inactive, activated when you save", () => { setBusiness(null); setAgent(null); }) : (
                <SearchPick label="Business" addNoun="business" searchWhenEmpty placeholder="Search business name, ABN or agent" search={searchBusinesses}
                  onPick={(option) => { const row = (option as PickOption & { raw: Business }).raw; setBusiness({ id: row.id, name: row.name, status: row.status }); setAgent(null); }}
                  onAddNew={() => { setInitialAgentName(""); setRecordDialogMode("business"); }} />
              )) : null}
              {business ? (agent ? chip(agent.name, [agent.email, agent.role === "agency_admin" ? "Business admin agent" : "Agent"].filter(Boolean).join(", "), () => setAgent(null)) : (
                <SearchPick label="Agent" addNoun="agent" placeholder={`Search or pick an agent at ${business.name}`} resetKey={business.id} searchWhenEmpty openOnMount search={searchAgents}
                  onPick={(option) => {
                    const raw = (option as PickOption & { raw: BusinessAgentOption & { otherBusiness?: { id: string; name: string; status: "Active" } } }).raw;
                    if (raw.otherBusiness) setBusiness({ id: raw.otherBusiness.id, name: raw.otherBusiness.name, status: raw.otherBusiness.status });
                    const { otherBusiness: _other, ...agentOnly } = raw; void _other; setAgent(agentOnly);
                  }}
                  onAddNew={role === "slit_admin" ? (name) => { setInitialAgentName(name); setRecordDialogMode("agent"); } : undefined} />
              )) : null}
              {err("agent")}
            </div>
          )}
          {role === "agent" && field.agent ? <p role="alert" className="text-sm text-red-800">Your sign-in is not set up as an agent of this business yet. Ask your administrator.</p> : null}
          {problem ? <p role="alert" className="text-sm text-red-800">{problem}</p> : null}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      </Modal>
      <AddStudentRecordDialog mode={recordDialogMode} initialAgentName={initialAgentName}
        business={business ? { id: business.id, name: business.name, status: business.status } : null}
        onCancel={() => setRecordDialogMode(null)} onSave={saveNewRecord} />
    </>
  );
}
