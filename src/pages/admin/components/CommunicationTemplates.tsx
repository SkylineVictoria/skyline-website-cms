import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Modal, Select, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import {
  CHANNELS,
  CHANNEL_LABELS,
  TEMPLATE_CATEGORIES,
  TEMPLATE_VARIABLES,
  channelText,
  renderTemplate,
  sampleValues,
  smsInfo,
  templateKeyFrom,
  templateVariables,
  type Channel,
  type CommunicationTemplate,
  type TemplateCategory,
} from "@/lib/communicationTemplates";

type Row = {
  id: string; key: string; name: string; category: TemplateCategory; audience: string; description: string; subject: string; body: string;
  channels: Channel[]; status: "active" | "archived"; is_system: boolean; updated_at: string;
};
const COLUMNS = "id,key,name,category,audience,description,subject,body,channels,status,is_system,updated_at";
const toTemplate = (r: Row): CommunicationTemplate => ({
  id: r.id, key: r.key, name: r.name, category: r.category, audience: r.audience, description: r.description, subject: r.subject, body: r.body,
  channels: r.channels, status: r.status, isSystem: r.is_system, updatedAt: r.updated_at,
});
const CHANNEL_ICONS: Record<Channel, string> = { email: "ri-mail-line", sms: "ri-message-2-line", whatsapp: "ri-whatsapp-line" };

type Draft = Omit<CommunicationTemplate, "updatedAt" | "isSystem" | "status"> & { isSystem: boolean; status: "active" | "archived" };
const blankDraft = (): Draft => ({ id: "", key: "", name: "", category: "General", audience: "", description: "", subject: "", body: "", channels: [...CHANNELS], isSystem: false, status: "active" });

export default function CommunicationTemplates() {
  const { push } = useToast();
  const [items, setItems] = useState<CommunicationTemplate[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"" | TemplateCategory>("");
  const [channel, setChannel] = useState<"" | Channel>("");
  const [showArchived, setShowArchived] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    const { data, error } = await supabase.from("communication_templates").select(COLUMNS).order("category").order("name");
    setItems(((data ?? []) as Row[]).map(toTemplate));
    setError(error?.message ?? "");
    setBusy(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((t) =>
      (showArchived || t.status === "active") && (!category || t.category === category) && (!channel || t.channels.includes(channel)) &&
      (!q || [t.name, t.subject, t.body, t.audience, t.key].some((s) => s.toLowerCase().includes(q))));
  }, [items, query, category, channel, showArchived]);
  const groups = useMemo(() => TEMPLATE_CATEGORIES.map((c) => [c, shown.filter((t) => t.category === c)] as const).filter(([, list]) => list.length), [shown]);

  const openNew = () => setDraft(blankDraft());
  const openEdit = (t: CommunicationTemplate) => setDraft({ ...t });
  const duplicate = (t: CommunicationTemplate) => setDraft({ ...t, id: "", key: "", name: `${t.name} (copy)`, isSystem: false, status: "active" });

  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-background-200 bg-background-50 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-semibold">Message templates</h2>
            <p className="mt-1 max-w-2xl text-sm text-foreground-600">
              One template works for email, SMS and WhatsApp: the subject is used for email, and the same message is used everywhere. Words in
              {" "}<code className="rounded bg-background-200 px-1">{"{{double braces}}"}</code> are filled in for each person.
            </p>
          </div>
          <Button icon="ri-add-line" onClick={openNew}>New template</Button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search"><TextInput value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Name, subject or message" /></Field>
          <Field label="Area">
            <Select value={category} onChange={(e) => setCategory(e.target.value as "" | TemplateCategory)}>
              <option value="">All areas</option>
              {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Field>
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value as "" | Channel)}>
              <option value="">All channels</option>
              {CHANNELS.map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </Select>
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm text-foreground-700">
            <input type="checkbox" className="h-4 w-4" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
            Show archived
          </label>
        </div>
      </div>

      {busy ? <p role="status">Loading templates…</p>
        : error ? <p role="alert" className="rounded-lg border border-red-300 p-4">Unable to load templates: {error}</p>
        : groups.length === 0 ? <EmptyState icon="ri-file-text-line" title="No templates found" description="Try another search or filter, or create a new template." />
        : groups.map(([cat, list]) => (
          <div key={cat} className="space-y-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-foreground-500">{cat} <span className="font-normal">({list.length})</span></h3>
            <div className="grid gap-2 md:grid-cols-2">
              {list.map((t) => (
                <article key={t.id} className={`rounded-xl border bg-background-50 p-4 ${t.status === "archived" ? "border-dashed border-background-300 opacity-70" : "border-background-200"}`}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <h4 className="font-semibold text-foreground-950">{t.name}</h4>
                      <p className="text-xs text-foreground-500">{t.audience || "Anyone"}{t.status === "archived" ? " · Archived" : ""}</p>
                    </div>
                    <div className="flex gap-1">{t.channels.map((c) => <Badge key={c} tone="secondary"><i className={CHANNEL_ICONS[c]} aria-hidden="true" />{CHANNEL_LABELS[c]}</Badge>)}</div>
                  </div>
                  {t.subject ? <p className="mt-2 truncate text-sm font-medium text-foreground-800">{t.subject}</p> : null}
                  <p className="mt-1 line-clamp-2 whitespace-pre-line text-sm text-foreground-600">{t.body}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" icon="ri-edit-line" onClick={() => openEdit(t)}>Open</Button>
                    <Button size="sm" variant="ghost" icon="ri-file-copy-line" onClick={() => duplicate(t)}>Duplicate</Button>
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}

      {draft ? <TemplateEditor draft={draft} existingKeys={items.map((t) => t.key)} onClose={() => setDraft(null)}
        onSaved={(msg) => { push(msg); setDraft(null); void load(); }} /> : null}
    </section>
  );
}

function TemplateEditor({ draft: initial, existingKeys, onClose, onSaved }: { draft: Draft; existingKeys: string[]; onClose: () => void; onSaved: (message: string) => void }) {
  const { push } = useToast();
  const [d, setD] = useState<Draft>(initial);
  const [preview, setPreview] = useState<Channel>(initial.channels[0] ?? "email");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const isNew = !d.id;
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const used = templateVariables(d.subject, d.body);
  const known = new Set(TEMPLATE_VARIABLES.map((v) => v.name));
  const unknown = used.filter((n) => !known.has(n));
  const text = channelText(preview, d.body);
  const sms = smsInfo(channelText("sms", d.body));
  const problems = [
    !d.name.trim() && "Give the template a name.",
    !d.body.trim() && "Write the message.",
    d.channels.length === 0 && "Choose at least one channel.",
    d.channels.includes("email") && !d.subject.trim() && "Email needs a subject.",
  ].filter(Boolean) as string[];

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    const el = bodyRef.current;
    if (!el) { set("body", d.body + token); return; }
    const start = el.selectionStart ?? d.body.length, end = el.selectionEnd ?? start;
    const next = d.body.slice(0, start) + token + d.body.slice(end);
    set("body", next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length); });
  };
  const toggleChannel = (c: Channel) => set("channels", d.channels.includes(c) ? d.channels.filter((x) => x !== c) : CHANNELS.filter((x) => x === c || d.channels.includes(x)));
  const copy = async () => {
    const full = preview === "email" ? `${renderTemplate(d.subject, sampleValues())}\n\n${text}` : text;
    try { await navigator.clipboard.writeText(full); push("Copied with sample details filled in."); } catch { push("Copy is not available in this browser.", "error"); }
  };

  const save = async (status = d.status) => {
    if (problems.length) return;
    setSaving(true);
    const fields = { name: d.name.trim(), category: d.category, audience: d.audience.trim(), description: d.description.trim(), subject: d.subject.trim(), body: d.body.trim(), channels: d.channels, status };
    let error: { message: string } | null;
    if (isNew) {
      let key = templateKeyFrom(d.name) || "template";
      if (!/^[a-z]/.test(key)) key = `t_${key}`;
      for (let i = 2; existingKeys.includes(key); i++) key = `${templateKeyFrom(d.name).slice(0, 55)}_${i}`;
      ({ error } = await supabase.from("communication_templates").insert({ ...fields, key }));
    } else {
      ({ error } = await supabase.from("communication_templates").update(fields).eq("id", d.id));
    }
    setSaving(false);
    if (error) { push(`Could not save: ${error.message}`, "error"); return; }
    onSaved(isNew ? "Template created." : status !== initial.status ? (status === "archived" ? "Template archived." : "Template restored.") : "Template saved.");
  };
  const remove = async () => {
    setSaving(true);
    const { error } = await supabase.from("communication_templates").delete().eq("id", d.id);
    setSaving(false);
    if (error) { push(`Could not delete: ${error.message}`, "error"); return; }
    onSaved("Template deleted.");
  };

  return (
    <Modal open title={isNew ? "New template" : d.name} onClose={onClose} width="max-w-5xl"
      footer={<div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          {!isNew ? <Button variant="outline" disabled={saving} onClick={() => void save(d.status === "archived" ? "active" : "archived")}>{d.status === "archived" ? "Restore" : "Archive"}</Button> : null}
          {!isNew && !d.isSystem ? <Button variant="ghost" disabled={saving} onClick={() => setConfirmDelete(true)}>Delete</Button> : null}
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={saving || problems.length > 0} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>}>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <Field label="Name" required><TextInput value={d.name} onChange={(e) => set("name", e.target.value)} maxLength={120} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Area">
              <Select value={d.category} onChange={(e) => set("category", e.target.value as TemplateCategory)}>
                {TEMPLATE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Sent to"><TextInput value={d.audience} onChange={(e) => set("audience", e.target.value)} placeholder="e.g. Student" maxLength={80} /></Field>
          </div>
          <Field label="When it is used"><TextInput value={d.description} onChange={(e) => set("description", e.target.value)} maxLength={300} /></Field>
          <fieldset>
            <legend className="mb-1.5 text-label font-medium text-foreground-800">Use on</legend>
            <div className="flex flex-wrap gap-4">
              {CHANNELS.map((c) => (
                <label key={c} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4" checked={d.channels.includes(c)} onChange={() => toggleChannel(c)} />
                  <i className={CHANNEL_ICONS[c]} aria-hidden="true" />{CHANNEL_LABELS[c]}
                </label>
              ))}
            </div>
          </fieldset>
          {d.channels.includes("email") ? <Field label="Email subject" required><TextInput value={d.subject} onChange={(e) => set("subject", e.target.value)} maxLength={200} /></Field> : null}
          <Field label="Message" required hint="Used for email, SMS and WhatsApp. *Stars* make text bold on WhatsApp.">
            <textarea ref={bodyRef} rows={10} value={d.body} onChange={(e) => set("body", e.target.value)} maxLength={4000}
              className="w-full rounded-md border border-background-300 bg-background-50 px-[var(--control-px)] py-[var(--control-py)] text-sm text-foreground-900 outline-none transition-colors duration-fast ease-out placeholder:text-foreground-400 focus:border-primary-400 focus:ring-2 focus:ring-primary-100" />
          </Field>
          <div>
            <p className="mb-1.5 text-label font-medium text-foreground-800">Insert a detail</p>
            <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
              {TEMPLATE_VARIABLES.map((v) => (
                <button key={v.name} type="button" onClick={() => insert(v.name)} title={`{{${v.name}}}`}
                  className={`rounded-full border px-2.5 py-0.5 text-xs ${used.includes(v.name) ? "border-primary-300 bg-primary-50 text-primary-800" : "border-background-300 bg-background-50 text-foreground-700 hover:bg-background-100"}`}>
                  {v.label}
                </button>
              ))}
            </div>
            {unknown.length ? <p className="mt-2 text-xs text-primary-800">Not a known detail (will show as written): {unknown.map((n) => `{{${n}}}`).join(", ")}</p> : null}
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-1" role="tablist" aria-label="Preview">
              {CHANNELS.map((c) => (
                <button key={c} type="button" role="tab" aria-selected={preview === c} onClick={() => setPreview(c)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${preview === c ? "bg-primary-500 text-white" : "border border-background-200 text-foreground-700"}`}>
                  <i className={`${CHANNEL_ICONS[c]} mr-1`} aria-hidden="true" />{CHANNEL_LABELS[c]}
                </button>
              ))}
            </div>
            <Button size="sm" variant="outline" icon="ri-file-copy-line" onClick={() => void copy()}>Copy</Button>
          </div>
          <p className="text-xs text-foreground-500">Preview with sample details.{d.channels.includes(preview) ? "" : ` This template is not set for ${CHANNEL_LABELS[preview]}.`}</p>
          {preview === "email" ? (
            <div className="rounded-xl border border-background-200 bg-background-50">
              <p className="border-b border-background-200 px-4 py-2 text-sm"><span className="text-foreground-500">Subject: </span><span className="font-semibold">{renderTemplate(d.subject, sampleValues()) || "(no subject)"}</span></p>
              <p className="whitespace-pre-wrap px-4 py-3 text-sm text-foreground-800">{text || "(empty)"}</p>
            </div>
          ) : preview === "sms" ? (
            <div className="space-y-2">
              <div className="ml-auto max-w-sm whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary-500 px-4 py-3 text-sm text-white">{text || "(empty)"}</div>
              <p className="text-right text-xs text-foreground-500">{sms.characters} characters · {sms.segments} SMS {sms.segments === 1 ? "part" : "parts"} ({sms.encoding}){sms.segments > 3 ? " — consider shortening for SMS" : ""}</p>
            </div>
          ) : (
            <div className="rounded-xl bg-[#e5ddd5] p-4">
              <div className="max-w-sm whitespace-pre-wrap rounded-lg rounded-tl-none bg-white px-3 py-2 text-sm text-[#111b21] shadow-sm"
                dangerouslySetInnerHTML={{ __html: whatsAppHtml(text || "(empty)") }} />
            </div>
          )}
          {d.isSystem ? <p className="text-xs text-foreground-500">Built-in template (key <code>{d.key}</code>). You can edit or archive it; it cannot be deleted.</p> : null}
          <p className="text-xs text-foreground-500">Templates do not send anything by themselves. Automatic messages keep their current wording until they are linked to a template.</p>
        </div>
      </div>
      <ConfirmDialog open={confirmDelete} title="Delete this template?" message="This cannot be undone." confirmLabel="Delete" onConfirm={() => { setConfirmDelete(false); void remove(); }} onCancel={() => setConfirmDelete(false)} />
    </Modal>
  );
}

/** WhatsApp-style formatting for the preview only: text is escaped first, then *bold*, _italic_ and ~strike~ are shown. */
function whatsAppHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return esc.replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>").replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, "$1<em>$2</em>").replace(/~([^~\n]+)~/g, "<del>$1</del>");
}
