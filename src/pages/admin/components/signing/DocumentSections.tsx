import { useEffect, useState } from "react";
import { Button, TextInput } from "../ui";
import RichTextEditor from "@/pages/admin/components/RichTextEditor";
import { deleteTemplatePart, listTemplateParts, saveTemplatePart, type TemplatePart } from "@/lib/signingApi";
import { docxToTemplateHtml } from "@/lib/docxImport";
import { richPlainText, sanitizeRichHtml } from "../../../../../supabase/functions/_shared/rich-html";
import { TEMPLATE_VARIABLES } from "../../../../../supabase/functions/_shared/template-variables";
import { SECTION_TITLES as TITLES, type Section, type Sections } from "@/lib/templateSections";
import type { LetterVariable } from "../../../../../supabase/functions/_shared/letter-variables";
const LETTER_HINT: Record<Section, string> = {
  header: "Printed at the top of every page. A two-column table with its borders off puts the logo (Insert image, or paste) on the left and the office details on the right.",
  body: "The text of the letter. It flows across as many pages as it needs. Insert variables from the list; they print the application's details.",
  footer: "Printed at the bottom of every page. Page number and Total pages (Page group) are filled per page; Initials line puts the student's initials line on every page.",
};
const HINT: Record<Section, string> = {
  header: "Printed at the top of every page. A table with its borders turned off puts the logo on the left and the office details on the right.",
  body: "The text of the document. It flows across as many pages as it needs.",
  footer: "Printed at the bottom of every page. [Page Number] and [Total Pages] are filled per page; [Student Initial] becomes the signer's initials on every page.",
};

/**
 * Header, Body and Footer of a document template (TPL-02), each with the full document toolbar and the variable picker. A header or
 * footer can be filled from a saved preset (the preset's HTML is copied in) or saved as one; a Word document can start the body.
 */
export default function DocumentSections({ value, onChange, onError, letterVariables, storageImages = false }: {
  value: Sections; onChange: (patch: Partial<Sections>) => void; onError: (message: string) => void;
  /** Offer letters: {{variable}} chips from the registry instead of [Variables]. */ letterVariables?: readonly LetterVariable[];
  /** Pictures go to the template-assets bucket. */ storageImages?: boolean;
}) {
  const [tab, setTab] = useState<Section>("body");
  const [parts, setParts] = useState<TemplatePart[] | null>(null);
  const [presetName, setPresetName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { void listTemplateParts().then(setParts).catch(() => setParts([])); }, []);
  const key = `${tab}_html` as keyof Sections;
  const kind = tab === "body" ? null : tab;
  const options = (parts ?? []).filter((p) => p.kind === kind);
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setNote(""); onError(""); try { await work(); } catch (e) { onError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); } };

  const applyPreset = (id: string) => {
    const part = options.find((p) => p.id === id);
    if (!part) return;
    if (richPlainText(value[key]).trim() && !window.confirm(`Replace the current ${tab} with the preset "${part.name}"?`)) return;
    onChange({ [key]: sanitizeRichHtml(part.html) });
    setNote(`The ${tab} now uses a copy of "${part.name}". Changing the preset later does not change this template.`);
  };
  const savePreset = () => act(async () => {
    if (!kind) return;
    const html = sanitizeRichHtml(value[key]);
    if (!richPlainText(html).trim() && !/<img/.test(html)) throw new Error(`The ${tab} is empty. Write it first, then save it as a preset.`);
    const saved = await saveTemplatePart({ kind, name: presetName.trim(), html });
    setParts((list) => [...(list ?? []).filter((p) => p.id !== saved.id), saved]);
    setPresetName(""); setNote(`Saved as the ${kind} preset "${saved.name}".`);
  });
  const removePreset = (id: string) => act(async () => {
    const part = options.find((p) => p.id === id);
    if (!part || !window.confirm(`Delete the ${part.kind} preset "${part.name}"? Templates that already use it keep their copy.`)) return;
    await deleteTemplatePart(id);
    setParts((list) => (list ?? []).filter((p) => p.id !== id));
  });
  const importDocx = (file: File | undefined) => act(async () => {
    if (!file) return;
    if (richPlainText(value.body_html).trim() && !window.confirm("Replace the body with the Word document?")) return;
    const result = await docxToTemplateHtml(await file.arrayBuffer());
    onChange({ body_html: result.html });
    setNote(["The Word document is now the body. Check tables, headings and alignment, then choose a header and footer.",
      result.droppedImages ? `${result.droppedImages} picture(s) were left out (only PNG and JPEG under 290 KB are kept).` : ""].filter(Boolean).join(" "));
  });

  const [selected, setSelected] = useState("");
  return (
    <div className="space-y-2" data-testid="document-sections">
      <div role="tablist" aria-label="Template sections" className="flex flex-wrap gap-1 border-b border-background-300">
        {(["header", "body", "footer"] as Section[]).map((s) => (
          <button key={s} type="button" role="tab" aria-selected={tab === s} onClick={() => { setTab(s); setNote(""); setSelected(""); }} data-testid={`section-tab-${s}`}
            className={`-mb-px rounded-t-md border px-4 py-1.5 text-sm font-medium ${tab === s ? "border-background-300 border-b-white bg-white text-foreground-900" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>
            {TITLES[s]}{s !== "body" && richPlainText(value[`${s}_html` as keyof Sections]).trim() ? " ✓" : ""}
          </button>
        ))}
      </div>
      <p className="text-xs text-foreground-600">{(letterVariables ? LETTER_HINT : HINT)[tab]}</p>
      {kind ? (
        <div className="flex flex-wrap items-end gap-2 rounded-md border border-background-200 bg-background-50 p-2 text-sm">
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground-700">Use a saved {kind}
            <select value={selected} onChange={(e) => { setSelected(e.target.value); applyPreset(e.target.value); }} className="h-9 rounded border border-background-300 bg-white px-2 text-sm" data-testid={`preset-${kind}`}>
              <option value="">{parts === null ? "Loading…" : options.length ? `Choose a ${kind}` : `No saved ${kind}s yet`}</option>
              {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {selected ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void removePreset(selected)}>Delete this preset</Button> : null}
          <span className="flex-1" />
          <label className="flex flex-col gap-1 text-xs font-medium text-foreground-700">Save this {kind} as a preset
            <TextInput value={presetName} maxLength={80} placeholder={`e.g. SLIT ${kind}`} onChange={(e) => setPresetName(e.target.value)} className="!h-9 !w-56" data-testid={`preset-${kind}-name`} />
          </label>
          <Button variant="outline" size="sm" disabled={busy || !presetName.trim()} onClick={() => void savePreset()} data-testid={`preset-${kind}-save`}>Save preset</Button>
        </div>
      ) : (
        <label className="flex flex-wrap items-center gap-2 text-sm">Start from a Word document (.docx):
          <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} data-testid="docx-input"
            onChange={(e) => { void importDocx(e.target.files?.[0]); e.target.value = ""; }} /></label>
      )}
      {note ? <p role="status" className="text-xs text-foreground-700">{note}</p> : null}
      <RichTextEditor key={tab} mode="document" value={value[key]} onChange={(html) => onChange({ [key]: html })} variables={letterVariables ? undefined : TEMPLATE_VARIABLES} minHeight={tab === "body" ? 360 : 140}
        letterVariables={letterVariables} storageImages={storageImages}
        label={`${TITLES[tab]} of the template`} testId={`section-editor-${tab}`} placeholder={tab === "body" ? "Write the document, or start from a Word document." : `The ${tab} of every page (optional).`} />
    </div>
  );
}
