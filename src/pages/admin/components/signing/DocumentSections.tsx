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
  header: "Printed at the top of every page. A table with its borders turned off puts the logo on the left and the office details on the right. [Variables] such as [Student Name] or [Date] work here too.",
  body: "The text of the document. It flows across as many pages as it needs.",
  footer: "Printed at the bottom of every page. [Page Number] and [Total Pages] are filled per page; [Student Initial] becomes the signer's initials on every page.",
};
const EMPTY_NOTE: Record<Exclude<Section, "body">, string> = {
  header: "Leave empty to use the logo and name from Website Settings.",
  footer: "Leave empty for no footer.",
};
/** True when a section holds something worth keeping (text or a picture). */
const sectionFilled = (html: string) => Boolean(richPlainText(html).trim()) || /<img\b/i.test(html);

/**
 * Header, Body and Footer of a document template (TPL-02), stacked in print order, each with the full document toolbar and the variable
 * picker. A header or footer can be filled from a saved preset (the preset's HTML is copied in), saved as one, or cleared; a Word
 * document can start the body. Pictures are uploaded to template-assets and linked by URL.
 */
export default function DocumentSections({ value, onChange, onError, letterVariables, storageImages = false }: {
  value: Sections; onChange: (patch: Partial<Sections>) => void; onError: (message: string) => void;
  /** Offer letters: {{variable}} chips from the registry instead of [Variables]. */ letterVariables?: readonly LetterVariable[];
  /** Pictures go to the template-assets bucket. */ storageImages?: boolean;
}) {
  const [parts, setParts] = useState<TemplatePart[] | null>(null);
  const [presetName, setPresetName] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => { void listTemplateParts().then(setParts).catch(() => setParts([])); }, []);
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); onError(""); try { await work(); } catch (e) { onError(e instanceof Error ? e.message : "Please try again."); } finally { setBusy(false); } };
  const say = (section: Section, text: string) => setNote((n) => ({ ...n, [section]: text }));

  const applyPreset = (kind: "header" | "footer", id: string) => {
    const key = `${kind}_html` as const;
    const part = (parts ?? []).find((p) => p.id === id && p.kind === kind);
    if (!part) return;
    if (sectionFilled(value[key]) && !window.confirm(`Replace the current ${kind} with the preset "${part.name}"?`)) return;
    onChange({ [key]: sanitizeRichHtml(part.html) });
    say(kind, `The ${kind} now uses a copy of "${part.name}". Changing the preset later does not change this template.`);
  };
  const savePreset = (kind: "header" | "footer") => act(async () => {
    const key = `${kind}_html` as const;
    const html = sanitizeRichHtml(value[key]);
    if (!sectionFilled(html)) throw new Error(`The ${kind} is empty. Write it first, then save it as a preset.`);
    const name = (presetName[kind] ?? "").trim() || (window.prompt(`Name for this ${kind} preset`, "") ?? "").trim();
    if (!name) return;
    const saved = await saveTemplatePart({ kind, name, html });
    setParts((list) => [...(list ?? []).filter((p) => p.id !== saved.id), saved]);
    setPresetName((n) => ({ ...n, [kind]: "" }));
    say(kind, `Saved as the ${kind} preset "${saved.name}". Manage presets from Documents & Signatures › Templates › Header & footer presets.`);
  });
  const removePreset = (kind: "header" | "footer", id: string) => act(async () => {
    const part = (parts ?? []).find((p) => p.id === id);
    if (!part || !window.confirm(`Delete the ${part.kind} preset "${part.name}"? Templates that already use it keep their copy.`)) return;
    await deleteTemplatePart(id);
    setParts((list) => (list ?? []).filter((p) => p.id !== id));
    setSelected((s) => ({ ...s, [kind]: "" }));
  });
  const clearSection = (kind: "header" | "footer") => {
    const key = `${kind}_html` as const;
    if (sectionFilled(value[key]) && !window.confirm(`Clear the ${kind}? ${EMPTY_NOTE[kind]}`)) return;
    onChange({ [key]: "" });
    setSelected((s) => ({ ...s, [kind]: "" }));
    say(kind, `The ${kind} is empty. ${EMPTY_NOTE[kind]}`);
  };
  const importDocx = (file: File | undefined) => act(async () => {
    if (!file) return;
    if (richPlainText(value.body_html).trim() && !window.confirm("Replace the body with the Word document?")) return;
    const result = await docxToTemplateHtml(await file.arrayBuffer());
    onChange({ body_html: result.html });
    say("body", ["The Word document is now the body. Check tables, headings and alignment, then choose a header and footer.",
      result.droppedImages ? `${result.droppedImages} picture(s) were left out (only PNG and JPEG under 290 KB are kept).` : ""].filter(Boolean).join(" "));
  });

  const presetBar = (kind: "header" | "footer") => {
    const options = (parts ?? []).filter((p) => p.kind === kind);
    const chosen = selected[kind] ?? "";
    return <div className="flex flex-wrap items-end gap-2 rounded-md border border-background-200 bg-background-50 p-2 text-sm" data-testid={`section-tools-${kind}`}>
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground-700">Use preset
        <select value={chosen} onChange={(e) => { setSelected((s) => ({ ...s, [kind]: e.target.value })); applyPreset(kind, e.target.value); }} className="h-9 rounded border border-background-300 bg-white px-2 text-sm" data-testid={`preset-${kind}`}>
          <option value="">{parts === null ? "Loading…" : options.length ? `Choose a saved ${kind}` : `No saved ${kind}s yet`}</option>
          {options.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      {chosen ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void removePreset(kind, chosen)}>Delete this preset</Button> : null}
      <Button variant="outline" size="sm" disabled={busy || !sectionFilled(value[`${kind}_html`])} onClick={() => clearSection(kind)} data-testid={`section-clear-${kind}`}>Clear</Button>
      <span className="flex-1" />
      <label className="flex flex-col gap-1 text-xs font-medium text-foreground-700">Save as preset
        <TextInput value={presetName[kind] ?? ""} maxLength={80} placeholder={`Name, e.g. SLIT ${kind}`} onChange={(e) => setPresetName((n) => ({ ...n, [kind]: e.target.value }))} className="!h-9 !w-56" data-testid={`preset-${kind}-name`} />
      </label>
      <Button variant="outline" size="sm" disabled={busy || !sectionFilled(value[`${kind}_html`])} onClick={() => void savePreset(kind)} data-testid={`preset-${kind}-save`}>Save as preset</Button>
    </div>;
  };

  const section = (s: Section) => {
    const key = `${s}_html` as keyof Sections;
    const filled = s !== "body" && sectionFilled(value[key]);
    return <section key={s} className="space-y-2 rounded-md border border-background-300 p-3" data-testid={`section-${s}`} aria-labelledby={`section-title-${s}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`section-title-${s}`} className="font-semibold" data-testid={`section-tab-${s}`}>{TITLES[s]}{filled ? " ✓" : ""}</h3>
        {s !== "body" && <span className="text-xs text-foreground-500">{filled ? "" : EMPTY_NOTE[s]}</span>}
      </div>
      <p className="text-xs text-foreground-600">{(letterVariables ? LETTER_HINT : HINT)[s]}</p>
      {s === "body"
        ? <label className="flex flex-wrap items-center gap-2 text-sm">Start from a Word document (.docx):
          <input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} data-testid="docx-input"
            onChange={(e) => { void importDocx(e.target.files?.[0]); e.target.value = ""; }} /></label>
        : presetBar(s)}
      {note[s] ? <p role="status" className="text-xs text-foreground-700">{note[s]}</p> : null}
      <RichTextEditor mode="document" value={value[key]} onChange={(html) => onChange({ [key]: html })} variables={letterVariables ? undefined : TEMPLATE_VARIABLES} minHeight={s === "body" ? 360 : 140}
        letterVariables={letterVariables} storageImages={storageImages}
        label={`${TITLES[s]} of the template`} testId={`section-editor-${s}`} placeholder={s === "body" ? "Write the document, or start from a Word document." : `The ${s} of every page (optional). ${EMPTY_NOTE[s]}`} />
    </section>;
  };

  return (
    <div className="space-y-3" data-testid="document-sections">
      {(["header", "body", "footer"] as Section[]).map(section)}
    </div>
  );
}
