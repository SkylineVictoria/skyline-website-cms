/**
 * ASM-REVIEW (owner, 2026-11-23): a block edited in place in the wizard's Review step: the text as the student reads it, with a
 * small toolbar (bold, italic, bulleted / numbered list, link, picture, table). The admin never sees HTML tags; the block is still
 * stored as HTML (instruction blocks' config.html, the information pages). Pictures are embedded as JPEG data (as the workbook
 * import stores them), at most 1200 px wide.
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { sanitize } from "./registry";

const BTN = "flex h-8 min-w-8 cursor-pointer items-center justify-center gap-1 rounded px-1.5 text-sm text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40";
const SMALL = "cursor-pointer rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:border-primary-300 hover:text-primary-700";

/** The editor's HTML as stored: no empty paragraphs at the end, <b>/<i> as <strong>/<em>, nothing the sanitiser removes. */
function cleanRichHtml(html: string): string {
  const out = sanitize(html)
    .replace(/<(\/?)b(\s|>)/gi, "<$1strong$2").replace(/<(\/?)i(\s|>)/gi, "<$1em$2")
    .replace(/\s(style|class|contenteditable)="[^"]*"/gi, "")
    .replace(/(<p>(\s|&nbsp;|<br\s*\/?>)*<\/p>\s*)+$/i, "")
    .trim();
  return /^(<br\s*\/?>|\s|&nbsp;)*$/i.test(out) ? "" : out;
}

/** A picture file as a JPEG data URL, at most 1200 px wide. */
async function pictureData(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error("not a picture")); i.src = url; });
    const scale = Math.min(1, 1200 / img.naturalWidth);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.82);
  } finally { URL.revokeObjectURL(url); }
}

export default function RichBlockEditor({ value, onChange, label, placeholder = "Type here…", autoFocus = false, footer }: {
  value: string;
  onChange: (html: string) => void;
  label: string;
  placeholder?: string;
  autoFocus?: boolean;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const last = useRef<string>("");
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("https://");
  const [cell, setCell] = useState<HTMLTableCellElement | null>(null);
  const [notice, setNotice] = useState("");
  const [empty, setEmpty] = useState(!value);

  // the stored HTML is put in once, and again only when it changes from outside (never while typing: the caret would jump)
  useEffect(() => {
    const el = ref.current; if (!el) return;
    if (value !== last.current) {
      el.innerHTML = /^\s*</.test(value) ? sanitize(value) : value.split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>")}</p>`).join("");
      last.current = value; setEmpty(!value);
    }
  }, [value]);
  useEffect(() => {
    if (!autoFocus || !ref.current) return;
    ref.current.focus();
    const r = document.createRange(); r.selectNodeContents(ref.current); r.collapse(false);
    const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r);
  }, [autoFocus]);

  const emit = () => {
    const el = ref.current; if (!el) return;
    const html = cleanRichHtml(el.innerHTML);
    last.current = html; setEmpty(!html);
    onChange(html);
  };
  const remember = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) saved.current = sel.getRangeAt(0).cloneRange();
    const node = sel?.anchorNode ?? null;
    const td = (node instanceof Element ? node : node?.parentElement)?.closest("td, th") as HTMLTableCellElement | null;
    setCell(td && ref.current?.contains(td) ? td : null);
  };
  const restore = () => {
    ref.current?.focus();
    if (saved.current) { const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(saved.current); }
  };
  const exec = (command: string, arg?: string) => {
    restore();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("defaultParagraphSeparator", false, "p");
    document.execCommand(command, false, arg);
    remember(); emit();
  };
  const keep = (e: ReactMouseEvent) => e.preventDefault(); // the toolbar never takes the caret out of the text

  const applyLink = () => {
    const url = linkUrl.trim();
    setLinkOpen(false);
    if (!/^(https?:\/\/|mailto:)\S+$/i.test(url)) { setNotice("Links start with https://, http:// or mailto:."); return; }
    restore();
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) exec("createLink", url);
    else exec("insertHTML", `<a href="${url.replace(/"/g, "&quot;")}">${url.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</a>&nbsp;`);
    setNotice("");
  };
  const addPicture = async (file: File | undefined) => {
    if (!file) return;
    try { exec("insertHTML", `<figure><img src="${await pictureData(file)}" alt=""></figure><p><br></p>`); setNotice(""); }
    catch { setNotice("That file is not a picture."); }
  };
  const insertTable = () => exec("insertHTML", `<table><thead><tr><th>Heading</th><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td><br></td><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td><td><br></td></tr></tbody></table><p><br></p>`);
  const tableEdit = (what: "row" | "column" | "deleteRow" | "deleteTable") => {
    const td = cell; const table = td?.closest("table"); if (!td || !table) return;
    const row = td.parentElement as HTMLTableRowElement;
    if (what === "row") {
      const copy = document.createElement("tr");
      Array.from(row.cells).forEach(() => { const c = document.createElement("td"); c.innerHTML = "<br>"; copy.appendChild(c); });
      (row.parentElement?.tagName === "THEAD" ? table.tBodies[0] ?? table.createTBody() : row.parentElement!).insertBefore(copy, row.parentElement?.tagName === "THEAD" ? (table.tBodies[0]?.firstChild ?? null) : row.nextSibling);
    } else if (what === "column") {
      const index = td.cellIndex;
      Array.from(table.rows).forEach((r) => { const c = document.createElement(r.parentElement?.tagName === "THEAD" ? "th" : "td"); c.innerHTML = r.parentElement?.tagName === "THEAD" ? "Heading" : "<br>"; r.insertBefore(c, r.cells[index + 1] ?? null); });
    } else if (what === "deleteRow") {
      if (table.rows.length <= 1) table.remove(); else row.remove();
      setCell(null);
    } else { table.remove(); setCell(null); }
    emit();
  };

  return (
    <div className="rounded-lg border border-primary-300 bg-background-50 shadow-sm" data-testid="rich-block-editor">
      <div role="toolbar" aria-label={`${label}: formatting`} className="flex flex-wrap items-center gap-0.5 border-b border-background-200 bg-background-100 px-1.5 py-1">
        <button type="button" className={BTN} onMouseDown={keep} onClick={() => exec("bold")} title="Bold (Ctrl+B)" aria-label="Bold"><i className="ri-bold" aria-hidden="true" /></button>
        <button type="button" className={BTN} onMouseDown={keep} onClick={() => exec("italic")} title="Italic (Ctrl+I)" aria-label="Italic"><i className="ri-italic" aria-hidden="true" /></button>
        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />
        <button type="button" className={BTN} onMouseDown={keep} onClick={() => exec("insertUnorderedList")} title="Bulleted list" aria-label="Bulleted list"><i className="ri-list-unordered" aria-hidden="true" /></button>
        <button type="button" className={BTN} onMouseDown={keep} onClick={() => exec("insertOrderedList")} title="Numbered list" aria-label="Numbered list"><i className="ri-list-ordered" aria-hidden="true" /></button>
        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />
        <button type="button" className={BTN} onMouseDown={keep} onClick={() => { remember(); setLinkOpen((v) => !v); }} title="Link" aria-label="Link" aria-expanded={linkOpen}><i className="ri-link" aria-hidden="true" /></button>
        <label className={BTN} title="Picture" onMouseDown={remember}>
          <i className="ri-image-line" aria-hidden="true" /><span className="sr-only">Picture</span>
          <input type="file" accept="image/*" className="sr-only" onChange={(e) => { void addPicture(e.target.files?.[0]); e.target.value = ""; }} />
        </label>
        <button type="button" className={BTN} onMouseDown={keep} onClick={insertTable} title="Table" aria-label="Table"><i className="ri-table-line" aria-hidden="true" /></button>
        {cell ? (
          <span className="ml-1 flex flex-wrap items-center gap-1" aria-label="Table">
            <button type="button" className={SMALL} onMouseDown={keep} onClick={() => tableEdit("row")}>+ Row</button>
            <button type="button" className={SMALL} onMouseDown={keep} onClick={() => tableEdit("column")}>+ Column</button>
            <button type="button" className={SMALL} onMouseDown={keep} onClick={() => tableEdit("deleteRow")}>Delete row</button>
            <button type="button" className={SMALL} onMouseDown={keep} onClick={() => tableEdit("deleteTable")}>Delete table</button>
          </span>
        ) : null}
      </div>
      {linkOpen ? (
        <div className="flex items-center gap-2 border-b border-background-200 px-2 py-1.5">
          <input className="h-8 min-w-0 flex-1 rounded border border-background-300 bg-background-50 px-2 text-sm" value={linkUrl} aria-label="Link address" autoFocus onChange={(e) => setLinkUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") setLinkOpen(false); }} />
          <button type="button" className={SMALL} onClick={applyLink}>Add link</button>
        </div>
      ) : null}
      <div className="relative">
        {empty ? <p className="pointer-events-none absolute left-3 top-2.5 text-sm text-foreground-400">{placeholder}</p> : null}
        <div ref={ref} role="textbox" aria-multiline="true" aria-label={label} contentEditable suppressContentEditableWarning
          className="asm-content min-h-[4.5rem] px-3 py-2 text-sm text-foreground-800 focus:outline-none"
          onInput={emit} onKeyUp={remember} onMouseUp={remember} onBlur={remember}
          onPaste={(e) => {
            // pasted Word / web text keeps its words, lists and tables, never its styles or scripts
            const html = e.clipboardData.getData("text/html");
            if (!html) return;
            e.preventDefault();
            exec("insertHTML", cleanRichHtml(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?(span|font|o:p)[^>]*>/gi, "")));
          }} />
      </div>
      {notice ? <p className="border-t border-background-200 px-3 py-1.5 text-xs text-amber-800" role="status">{notice}</p> : null}
      {footer}
    </div>
  );
}
