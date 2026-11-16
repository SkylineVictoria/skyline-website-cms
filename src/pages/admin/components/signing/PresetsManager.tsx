import { useEffect, useState } from "react";
import { Button, Field, Modal, Select, TextInput } from "../ui";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import { deleteTemplatePart, listTemplateParts, saveTemplatePart, type TemplatePart } from "@/lib/signingApi";
import { richPlainText, sanitizeRichHtml } from "../../../../../supabase/functions/_shared/rich-html";
import { TEMPLATE_VARIABLES } from "../../../../../supabase/functions/_shared/template-variables";

type Draft = { id: string | null; kind: "header" | "footer"; name: string; html: string };
const filled = (html: string) => Boolean(richPlainText(html).trim()) || /<img\b/i.test(html);

/**
 * Header & footer presets: the saved parts a document template's header or footer can be copied from (signing_admin part_list /
 * part_save / part_delete). Renaming or editing a preset changes the preset only: templates keep the copy they took.
 */
export default function PresetsManager({ onClose }: { onClose: () => void }) {
  const [parts, setParts] = useState<TemplatePart[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => listTemplateParts().then(setParts).catch((e: Error) => { setParts([]); setError(e.message); });
  useEffect(() => { void load(); }, []);
  const act = async (work: () => Promise<void>, message = "") => {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { await work(); setNotice(message); } catch (e) { setError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); }
  };
  const save = () => act(async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) throw new Error("Give the preset a name.");
    const html = sanitizeRichHtml(draft.html);
    if (!filled(html)) throw new Error("The preset is empty. Write the header or footer first.");
    const saved = await saveTemplatePart({ id: draft.id, kind: draft.kind, name, html });
    setParts((list) => [...(list ?? []).filter((p) => p.id !== saved.id), saved].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)));
    setDraft(null);
  }, draft?.id ? "Preset saved. Templates that already use it keep their own copy." : "Preset added.");
  const remove = (part: TemplatePart) => {
    if (!window.confirm(`Delete the ${part.kind} preset "${part.name}"? Templates that already use it keep their copy.`)) return;
    void act(async () => { await deleteTemplatePart(part.id); setParts((list) => (list ?? []).filter((p) => p.id !== part.id)); }, "Preset deleted.");
  };

  if (draft) return <Modal open title={draft.id ? `Edit ${draft.kind} preset` : `New ${draft.kind} preset`} width="max-w-4xl" onClose={() => { if (!busy) setDraft(null); }}
    footer={<><Button variant="outline" disabled={busy} onClick={() => setDraft(null)}>Cancel</Button><Button disabled={busy} onClick={() => void save()} data-testid="preset-save">{busy ? "Saving…" : "Save preset"}</Button></>}>
    <div className="space-y-4" data-testid="preset-editor">
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-sm text-red-700">{error}</p>}
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Name" required><TextInput value={draft.name} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="preset-name" /></Field>
        <Field label="Used as"><Select value={draft.kind} disabled={Boolean(draft.id)} onChange={(e) => setDraft({ ...draft, kind: e.target.value === "footer" ? "footer" : "header" })}><option value="header">Header (top of every page)</option><option value="footer">Footer (bottom of every page)</option></Select></Field>
      </div>
      <p className="text-xs text-foreground-600">{draft.kind === "header" ? "A table with its borders off puts the logo on the left and the office details on the right. Pictures are uploaded to the template picture store." : "[Page Number] and [Total Pages] are filled per page; [Student Initial] becomes the signer's initials."} [Variables] such as [Student Name] and [Date] work here too.</p>
      <RichTextEditor mode="document" value={draft.html} onChange={(html) => setDraft((d) => (d ? { ...d, html } : d))} variables={TEMPLATE_VARIABLES} minHeight={200} storageImages label={`${draft.kind} preset`} testId="preset-html" />
    </div>
  </Modal>;

  return <Modal open title="Header & footer presets" width="max-w-3xl" onClose={onClose} footer={<Button variant="outline" onClick={onClose}>Close</Button>}>
    <div className="space-y-4 text-sm" data-testid="presets-manager">
      <p className="text-foreground-600">A preset is copied into a document template's header or footer with "Use preset". Changing or deleting a preset here does not change templates that already took a copy.</p>
      {error && <p role="alert" className="rounded border border-red-300 p-3 text-red-700">{error}</p>}
      {notice && <p role="status" className="rounded border border-green-300 p-3">{notice}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon="ri-add-line" disabled={busy} onClick={() => setDraft({ id: null, kind: "header", name: "", html: "" })} data-testid="preset-new-header">New header preset</Button>
        <Button size="sm" variant="outline" icon="ri-add-line" disabled={busy} onClick={() => setDraft({ id: null, kind: "footer", name: "", html: "" })} data-testid="preset-new-footer">New footer preset</Button>
      </div>
      {parts === null ? <p role="status">Loading…</p> : !parts.length ? <p className="text-foreground-600">No presets yet. Save a header or footer as a preset from a template, or add one here.</p>
        : <table className="w-full text-left" data-testid="presets-table"><thead className="text-xs text-foreground-500"><tr><th className="py-1 pr-3">Name</th><th className="pr-3">Used as</th><th className="pr-3">Preview</th><th className="pr-3">Updated</th><th /></tr></thead>
          <tbody>{parts.map((p) => <tr key={p.id} className="border-t border-background-200 align-top" data-testid="preset-row">
            <td className="py-2 pr-3 font-medium">{p.name}</td><td className="pr-3 capitalize">{p.kind}</td>
            <td className="max-w-xs pr-3 text-xs text-foreground-600"><span className="line-clamp-2">{richPlainText(p.html).trim() || (/<img\b/i.test(p.html) ? "(picture)" : "(empty)")}</span></td>
            <td className="pr-3 text-xs text-foreground-500">{new Date(p.updated_at).toLocaleDateString()}</td>
            <td className="py-2 text-right"><div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft({ id: p.id, kind: p.kind, name: p.name, html: p.html })} data-testid="preset-edit">Edit</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(p)} data-testid="preset-delete">Delete</Button>
            </div></td></tr>)}</tbody></table>}
    </div>
  </Modal>;
}
