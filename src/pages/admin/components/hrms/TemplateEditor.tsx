import { useEffect, useRef, type MouseEvent } from "react";
import { TEMPLATE_PROSE } from "@/pages/admin/lib/onboardingText";
import type { PlaceholderSpec } from "../../../../../supabase/functions/_shared/hr-template";

type Tool = { icon: string; label: string; command: string; arg?: string };
const TOOLS: Tool[][] = [
  [{ icon: "ri-bold", label: "Bold", command: "bold" }, { icon: "ri-italic", label: "Italic", command: "italic" }, { icon: "ri-underline", label: "Underline", command: "underline" }],
  [{ icon: "ri-h-2", label: "Heading", command: "formatBlock", arg: "h2" }, { icon: "ri-h-3", label: "Sub-heading", command: "formatBlock", arg: "h3" }, { icon: "ri-paragraph", label: "Paragraph", command: "formatBlock", arg: "p" }],
  [{ icon: "ri-list-unordered", label: "Bullet list", command: "insertUnorderedList" }, { icon: "ri-list-ordered", label: "Numbered list", command: "insertOrderedList" }],
  [{ icon: "ri-align-left", label: "Align left", command: "justifyLeft" }, { icon: "ri-align-center", label: "Align centre", command: "justifyCenter" }, { icon: "ri-align-right", label: "Align right", command: "justifyRight" }],
  [{ icon: "ri-separator", label: "Line", command: "insertHorizontalRule" }, { icon: "ri-format-clear", label: "Clear formatting", command: "removeFormat" }],
];

/**
 * The rich text editor for HRMS templates (the toolbar style of the CMS RichTextEditor, limited to what a letter or an email can
 * keep: bold, italic, underline, headings, lists, alignment, a line, links). Placeholders are inserted at the cursor from the
 * list beside it. The HTML is sanitised from an allow-list when it is saved and again whenever it is rendered.
 */
export default function TemplateEditor({ value, onChange, placeholders, minHeight = 320 }: {
  value: string; onChange: (html: string) => void; placeholders: PlaceholderSpec[]; minHeight?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);

  // The editor owns its content while it is open; the value only fills it when it changes from outside (opening a template).
  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== value) ref.current.innerHTML = value;
  }, [value]);

  const remember = () => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount && ref.current?.contains(selection.anchorNode)) range.current = selection.getRangeAt(0).cloneRange();
  };
  const restore = () => {
    ref.current?.focus();
    const selection = window.getSelection();
    if (range.current && selection) { selection.removeAllRanges(); selection.addRange(range.current); }
  };
  const emit = () => { if (ref.current) onChange(ref.current.innerHTML); remember(); };
  const run = (command: string, arg?: string) => {
    restore();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand(command, false, arg);
    emit();
  };
  const keep = (event: MouseEvent) => event.preventDefault(); // a toolbar click must not take the selection out of the text
  const link = () => {
    const url = window.prompt("Link address (https://…, mailto:… or a placeholder such as {{login_url}})", "https://");
    if (!url) return;
    run("createLink", url.trim());
  };
  const insert = (key: string) => { restore(); document.execCommand("insertText", false, `{{${key}}}`); emit(); };

  const groups = [...new Set(placeholders.map((p) => p.group))];
  return (
    <div className={placeholders.length ? "grid gap-3 lg:grid-cols-[1fr_230px]" : "grid gap-3"}>
      <div className="min-w-0 rounded-md border border-background-300 bg-background-50">
        <div className="flex flex-wrap items-center gap-1 border-b border-background-200 px-2 py-1.5" role="toolbar" aria-label="Formatting">
          {TOOLS.map((group, g) => (
            <span key={g} className="flex items-center gap-0.5 border-r border-background-200 pr-1 last:border-0">
              {group.map((tool) => (
                <button key={tool.label} type="button" title={tool.label} aria-label={tool.label} onMouseDown={keep} onClick={() => run(tool.command, tool.arg)}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-foreground-700 hover:bg-background-200">
                  <i className={`${tool.icon} text-base`} aria-hidden="true" />
                </button>
              ))}
            </span>
          ))}
          <button type="button" title="Link" aria-label="Link" onMouseDown={keep} onClick={link} className="flex h-8 w-8 cursor-pointer items-center justify-center rounded text-foreground-700 hover:bg-background-200"><i className="ri-link text-base" aria-hidden="true" /></button>
        </div>
        <div ref={ref} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Template text" data-testid="template-editor"
          onInput={emit} onBlur={emit} onKeyUp={remember} onMouseUp={remember}
          className={`overflow-y-auto bg-white px-5 py-4 outline-none ${TEMPLATE_PROSE}`} style={{ minHeight, maxHeight: "52vh" }} />
      </div>
      {placeholders.length ? <aside className="rounded-md border border-background-200 bg-background-100 p-3" aria-label="Placeholders">
        <p className="text-[13px] font-semibold text-foreground-900">Placeholders</p>
        <p className="mb-2 text-xs text-foreground-600">Click one to insert it where the cursor is. It is replaced with the person's details when the template is used.</p>
        <div className="max-h-[46vh] space-y-3 overflow-y-auto pr-1">
          {groups.map((group) => (
            <div key={group}>
              <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-foreground-500">{group}</p>
              <ul className="space-y-1">
                {placeholders.filter((p) => p.group === group).map((p) => (
                  <li key={p.key}>
                    <button type="button" onMouseDown={keep} onClick={() => insert(p.key)} data-testid={`template-placeholder-${p.key}`} title={`Example: ${p.sample}`}
                      className="w-full cursor-pointer rounded border border-background-300 bg-background-50 px-2 py-1 text-left text-xs hover:border-primary-300 hover:bg-primary-50">
                      <span className="block font-medium text-foreground-900">{p.label}</span>
                      <code className="text-[11px] text-foreground-600">{`{{${p.key}}}`}</code>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </aside> : null}
    </div>
  );
}
