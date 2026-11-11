import { useEffect, useMemo, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { TEMPLATE_PROSE } from "@/pages/admin/lib/onboardingText";
import { adminListStaff, type StaffListRow } from "@/lib/staffApi";
import { templatePerson } from "@/lib/hrTemplatesApi";
import { TEMPLATE_TYPES, placeholderLabels, renderMessage, sampleValues, templateValues, type TemplatePerson, type TemplateType } from "../../../../../supabase/functions/_shared/hr-template";

const ALERT = "rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900";
const SAMPLE_LINKS = { signing_link: "https://your-site/staff/welcome (personal link)", login_url: "https://your-site/login", document_link: "https://your-site/staff/onboard (personal link)",
  link_expiry: "24 November 2026", rejected_documents: "Passport: the photo page is cut off" };

export interface PreviewableTemplate { id?: string | null; type: TemplateType; name: string; subject: string; bodyHtml: string }

/** A letter or email template filled in with a chosen employee's real details (or sample details). Links are shown as examples. */
export default function TemplatePreviewDialog({ template, onClose }: { template: PreviewableTemplate; onClose: () => void }) {
  const [people, setPeople] = useState<StaffListRow[]>([]);
  const [search, setSearch] = useState("");
  const [personId, setPersonId] = useState("");
  const [person, setPerson] = useState<TemplatePerson | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(() => { void adminListStaff([], search, 25, 0).then((d) => { if (live) setPeople(d.rows); }, () => { if (live) setPeople([]); }); }, 200);
    return () => { live = false; window.clearTimeout(timer); };
  }, [search]);
  useEffect(() => {
    if (!personId) { setPerson(null); setError(""); return; }
    let live = true;
    templatePerson(personId).then((p) => { if (live) { setPerson(p); setError(""); } }, (e) => { if (live) { setPerson(null); setError(e instanceof Error ? e.message : "That person's details could not be loaded."); } });
    return () => { live = false; };
  }, [personId]);

  const rendered = useMemo(() => renderMessage(template, person ? templateValues(person, SAMPLE_LINKS) : { ...sampleValues(), ...SAMPLE_LINKS }), [template, person]);
  const gaps = [...rendered.missing, ...rendered.unknown];
  const kind = TEMPLATE_TYPES.find((t) => t.type === template.type)?.kind ?? "letter";
  return (
    <Modal open width="max-w-4xl" title={`Preview: ${template.name || "new template"}`} onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
      <div className="space-y-3" data-testid="template-preview-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Find an employee"><TextInput placeholder="Search by name or email" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="template-preview-search" /></Field>
          <Field label="Fill it in with">
            <Select value={personId} onChange={(e) => setPersonId(e.target.value)} data-testid="template-preview-person">
              <option value="">Sample details</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.name || p.email}</option>)}
            </Select>
          </Field>
        </div>
        {error ? <p role="alert" className={ALERT}>{error}</p> : null}
        {gaps.length ? <p role="alert" className={ALERT} data-testid="template-preview-missing">{person ? "This person has no value for" : "No value for"} <strong>{placeholderLabels(gaps)}</strong>. Sending is refused until every placeholder used has a value.</p> : null}
        <p className="text-[13px] font-medium text-foreground-800">{kind === "letter" ? "Title" : "Subject"}: <span className="font-normal" data-testid="template-preview-subject">{rendered.subject}</span></p>
        <div className="max-h-[52vh] overflow-y-auto rounded-md border border-background-300 bg-white px-6 py-5 shadow-sm">
          {/* Sanitised by renderMessage (allow-list rebuild); every value is escaped. */}
          <div className={TEMPLATE_PROSE} data-testid="template-preview-body" dangerouslySetInnerHTML={{ __html: rendered.html }} />
        </div>
        <p className="text-xs text-foreground-600">Links are examples here. The real personal link is made when the email is sent{kind === "letter" ? "; the letter is saved as a PDF" : ""}.</p>
      </div>
    </Modal>
  );
}
