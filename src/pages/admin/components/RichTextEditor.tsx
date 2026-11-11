import { useEffect, useId, useRef, useState, type MouseEvent } from "react";
import { BRACKET_TOKEN, isTokenName, MAX_IMAGE_CHARS, sanitizeRichHtml } from "../../../../supabase/functions/_shared/rich-html";
import { lookupVariable, type TemplateVariable } from "../../../../supabase/functions/_shared/template-variables";

/**
 * Lightweight rich-text editor used across the CMS for long-form content.
 * Provides a Word-document style toolbar (headings, fonts, sizes, bold/italic,
 * lists, alignment, links and images) and returns HTML via onChange.
 *
 * `mode="document"` (document templates, TPL-02) prints in one family (Arial, as the PDF's Arimo) and adds what a letter needs: sizes in points, text and highlight colour, sub / superscript,
 * special characters, pictures uploaded into the document, table borders on / off, a source (HTML) view, a picker of [Variables] and
 * highlighting of every [token] (blue: filled from the record, yellow: the signer fills it in, green: page numbers and initials). The
 * HTML it loads and the source it accepts go through the template allow-list. Without `mode` nothing changes for the CMS pages.
 */

/* [token] highlighting with the CSS Custom Highlight API (no change to the edited HTML); one set of ranges per editor on the page. */
type TokenKind = "known" | "field" | "auto";
const tokenRanges = new Map<string, Record<TokenKind, Range[]>>();
function paintTokenHighlights() {
  const g = globalThis as unknown as { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...ranges: Range[]) => unknown };
  const api = g.CSS?.highlights, HighlightCtor = g.Highlight;
  if (!api || !HighlightCtor) return;
  for (const kind of ["known", "field", "auto"] as TokenKind[]) {
    const ranges = [...tokenRanges.values()].flatMap((r) => r[kind]);
    api.set(`tpl-${kind}`, new HighlightCtor(...ranges));
  }
}
const DOC_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28];
const SPECIAL_CHARACTERS = ["©", "®", "™", "°", "±", "×", "÷", "€", "£", "¥", "§", "¶", "•", "–", "—", "…", "“", "”", "‘", "’", "½", "¼", "¾", "✓", "☐", "☑", "→", "≥", "≤", "≠"];

const FONTS = [
  { label: "Default", value: "" },
  { label: "Sora", value: "Sora" },
  { label: "Inter", value: "Inter" },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: "'Times New Roman', serif" },
  { label: "Arial", value: "Arial, sans-serif" },
  { label: "Courier New", value: "'Courier New', monospace" },
];

const SIZES = [
  { label: "Small", value: "2" },
  { label: "Normal", value: "3" },
  { label: "Large", value: "5" },
  { label: "Huge", value: "6" },
];

type ToolButton = { icon: string; command: string; arg?: string; label: string };

const TEXT_TOOLS: ToolButton[] = [
  { icon: "ri-bold", command: "bold", label: "Bold" },
  { icon: "ri-italic", command: "italic", label: "Italic" },
  { icon: "ri-underline", command: "underline", label: "Underline" },
  { icon: "ri-strikethrough", command: "strikeThrough", label: "Strikethrough" },
];

const LIST_TOOLS: ToolButton[] = [
  { icon: "ri-list-unordered", command: "insertUnorderedList", label: "Bullet list" },
  { icon: "ri-list-ordered", command: "insertOrderedList", label: "Numbered list" },
];

const ALIGN_TOOLS: ToolButton[] = [
  { icon: "ri-align-left", command: "justifyLeft", label: "Align left" },
  { icon: "ri-align-center", command: "justifyCenter", label: "Align center" },
  { icon: "ri-align-right", command: "justifyRight", label: "Align right" },
];

const BLOCK_OPTIONS = [
  { label: "Paragraph", value: "p" },
  { label: "Heading 2", value: "h2" },
  { label: "Heading 3", value: "h3" },
  { label: "Heading 4", value: "h4" },
  { label: "Quote", value: "blockquote" },
];

const selectClass =
  "h-8 cursor-pointer rounded border border-background-300 bg-background-50 px-2 text-xs text-foreground-800 focus:border-primary-400 focus:outline-none";

export default function RichTextEditor({
  value,
  onChange,
  placeholder = "Start writing…",
  minHeight = 220,
  mode = "cms",
  variables,
  label = "Rich text editor",
  testId,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  mode?: "cms" | "document";
  /** Document mode: the registry variables offered in the picker beside the text. */
  variables?: readonly TemplateVariable[];
  label?: string;
  testId?: string;
}) {
  const doc = mode === "document";
  const editorId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceText, setSourceText] = useState("");
  const [charsOpen, setCharsOpen] = useState(false);
  const [imgWidth, setImgWidth] = useState("");
  const [imgError, setImgError] = useState("");

  /** Document mode: finds every [token] in the text and highlights it by kind. */
  const markTokens = () => {
    if (!doc || !ref.current) return;
    const found: Record<TokenKind, Range[]> = { known: [], field: [], auto: [] };
    const walker = document.createTreeWalker(ref.current, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      for (const m of text.matchAll(BRACKET_TOKEN)) {
        if (!isTokenName(m[1])) continue;
        const spec = lookupVariable(m[1]);
        const range = document.createRange();
        range.setStart(node, m.index ?? 0);
        range.setEnd(node, (m.index ?? 0) + m[0].length);
        found[!spec ? "field" : spec.render || spec.field ? "auto" : "known"].push(range);
      }
    }
    tokenRanges.set(editorId, found);
    paintTokenHighlights();
  };
  useEffect(() => () => { tokenRanges.delete(editorId); paintTokenHighlights(); }, [editorId]);
  const savedRange = useRef<Range | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [imgOpen, setImgOpen] = useState(false);
  const [imgUrl, setImgUrl] = useState("");
  const [focused, setFocused] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);

  useEffect(() => {
    if (ref.current && ref.current.innerHTML !== (value ?? "")) {
      // A document template's HTML only ever enters the page through the allow-list.
      ref.current.innerHTML = doc ? sanitizeRichHtml(value ?? "") : value ?? "";
    }
    // Keep the table toolbar in sync when content is loaded/saved externally.
    setHasTable(Boolean(ref.current?.querySelector("table")));
    markTokens();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markTokens reads the DOM only
  }, [value]);

  const emit = () => {
    if (ref.current) onChange(ref.current.innerHTML);
    markTokens();
  };

  /** Document mode: a size in points (execCommand only knows 1-7, so size 7 is set and then replaced by the real size). */
  const applySize = (pt: number) => {
    restoreSelection();
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7");
    ref.current?.querySelectorAll('font[size="7"]').forEach((font) => {
      const span = document.createElement("span");
      span.style.fontSize = `${pt}pt`;
      span.innerHTML = font.innerHTML;
      font.replaceWith(span);
    });
    ref.current?.focus();
    emit();
  };
  const insertText = (text: string) => {
    restoreSelection();
    ref.current?.focus();
    document.execCommand("insertText", false, text);
    emit();
  };
  const uploadImage = (file: File | undefined) => {
    setImgError("");
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setImgError("Choose a PNG or JPEG picture."); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result ?? "");
      if (src.length > MAX_IMAGE_CHARS) { setImgError("This picture is too large. Use one under 290 KB (a logo of about 600 pixels wide is plenty)."); return; }
      restoreSelection();
      const width = Number(imgWidth);
      const html = `<img src="${src}" alt=""${width > 0 && width <= 1200 ? ` style="width:${width}px"` : ""}>`;
      document.execCommand("insertHTML", false, html);
      setImgOpen(false); setImgWidth("");
      emit();
    };
    reader.readAsDataURL(file);
  };
  /** Document mode: pasted HTML goes through the allow-list first, so no font, script or linked picture enters with it. */
  const pasteClean = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!doc) return;
    const html = event.clipboardData.getData("text/html");
    if (!html) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, sanitizeRichHtml(html));
    emit();
  };
  const toggleSource = () => {
    if (!ref.current) return;
    if (!sourceOpen) { setSourceText(ref.current.innerHTML); setSourceOpen(true); return; }
    ref.current.innerHTML = sanitizeRichHtml(sourceText);
    setSourceOpen(false);
    emit();
  };

  const exec = (command: string, arg?: string) => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false, arg);
    ref.current?.focus();
    emit();
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0 && ref.current && ref.current.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0);
    }
  };

  const restoreSelection = () => {
    const sel = window.getSelection();
    if (savedRange.current && sel) {
      sel.removeAllRanges();
      sel.addRange(savedRange.current);
    }
  };

  const stop = (e: MouseEvent) => e.preventDefault();

  const applyLink = () => {
    restoreSelection();
    const url = linkUrl.trim();
    if (url) document.execCommand("createLink", false, /^(https?:|mailto:|tel:|\/)/.test(url) ? url : `https://${url}`);
    setLinkOpen(false);
    setLinkUrl("");
    emit();
  };

  const applyImage = () => {
    restoreSelection();
    const url = imgUrl.trim();
    if (url) document.execCommand("insertImage", false, url);
    setImgOpen(false);
    setImgUrl("");
    emit();
  };

  /* ------------------------------------------------------------ tables */
  // The table toolbar is DOM-driven and tracks the "active" table so Add Row /
  // Add Column always have a target — even right after inserting a table, or
  // when reopening saved content (where there is no live cell selection).

  const tableStateRef = useRef<{ table: HTMLTableElement; cell: HTMLTableCellElement | null } | null>(null);
  const [hasTable, setHasTable] = useState(false);

  const currentCell = (): HTMLTableCellElement | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node: Node | null = sel.anchorNode;
    while (node && node !== ref.current) {
      if (node instanceof HTMLTableCellElement) return node;
      node = node.parentNode;
    }
    return null;
  };

  const tableFrom = (node: Node | null): HTMLTableElement | null => {
    let cursor: Node | null = node;
    while (cursor && cursor !== ref.current) {
      if (cursor instanceof HTMLTableElement) return cursor;
      cursor = cursor.parentNode;
    }
    return null;
  };

  /** Remembers the caret's table so the toolbar always edits the intended one. */
  const syncActiveTable = () => {
    const cell = currentCell();
    if (!cell) return;
    const table = tableFrom(cell);
    if (!table) return;
    tableStateRef.current = { table, cell };
    setHasTable(true);
  };

  /** Resolves the table to act on: caret cell → last used → last in the editor. */
  const resolveTable = (): { table: HTMLTableElement; cell: HTMLTableCellElement | null } | null => {
    const cell = currentCell();
    if (cell) {
      const table = tableFrom(cell);
      if (table) {
        tableStateRef.current = { table, cell };
        setHasTable(true);
        return { table, cell };
      }
    }
    const stored = tableStateRef.current;
    if (stored && ref.current?.contains(stored.table)) return stored;
    const last = (ref.current?.querySelector("table") as HTMLTableElement | null) ?? null;
    if (last) {
      const firstCell = last.querySelector("th,td") as HTMLTableCellElement | null;
      tableStateRef.current = { table: last, cell: firstCell };
      setHasTable(true);
      return { table: last, cell: firstCell };
    }
    return null;
  };

  const columnIndex = (cell: HTMLTableCellElement | null, table: HTMLTableElement): number => {
    if (cell) return cell.cellIndex;
    const firstRow = table.rows[0];
    return firstRow ? Math.max(firstRow.cells.length - 1, 0) : 0;
  };

  const insertTable = () => {
    const el = ref.current;
    if (!el) return;
    const rows = Math.max(1, Math.min(20, tableRows));
    const cols = Math.max(1, Math.min(12, tableCols));

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (let c = 0; c < cols; c += 1) {
      const th = document.createElement("th");
      th.textContent = `Header ${c + 1}`;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = document.createElement("tbody");
    for (let r = 1; r < rows; r += 1) {
      const tr = document.createElement("tr");
      for (let c = 0; c < cols; c += 1) {
        const td = document.createElement("td");
        td.innerHTML = "&nbsp;";
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const para = document.createElement("p");
    para.innerHTML = "<br>";

    el.focus();
    const sel = window.getSelection();
    let range: Range | null = null;
    if (sel && sel.rangeCount > 0 && el.contains(sel.anchorNode)) range = sel.getRangeAt(0);
    if (range) {
      range.deleteContents();
      range.insertNode(para);
      range.insertNode(table);
    } else {
      el.appendChild(table);
      el.appendChild(para);
    }

    const firstCell = table.querySelector("th,td") as HTMLTableCellElement | null;
    tableStateRef.current = { table, cell: firstCell };
    setHasTable(true);
    emit();
  };

  const addRow = (after: boolean) => {
    const resolved = resolveTable();
    if (!resolved) return;
    const { table, cell } = resolved;
    const refRow =
      cell?.parentElement instanceof HTMLTableRowElement ? cell.parentElement : table.rows[table.rows.length - 1];
    if (!refRow) return;
    const newRow = document.createElement("tr");
    for (let i = 0; i < refRow.cells.length; i += 1) {
      const td = document.createElement("td");
      td.innerHTML = "&nbsp;";
      newRow.appendChild(td);
    }
    if (after) refRow.after(newRow);
    else refRow.before(newRow);
    tableStateRef.current = { table, cell: newRow.cells[0] ?? null };
    setHasTable(true);
    emit();
  };

  const deleteRow = () => {
    const resolved = resolveTable();
    if (!resolved) return;
    const { table, cell } = resolved;
    const row =
      cell?.parentElement instanceof HTMLTableRowElement ? cell.parentElement : table.rows[table.rows.length - 1];
    if (!row) return;
    const parent = row.parentElement;
    row.remove();
    if (parent instanceof HTMLTableSectionElement && parent.rows.length === 0) parent.remove();
    if (table.rows.length === 0) {
      table.remove();
      tableStateRef.current = null;
      setHasTable(false);
    }
    emit();
  };

  const addColumn = (after: boolean) => {
    const resolved = resolveTable();
    if (!resolved) return;
    const { table, cell } = resolved;
    const index = columnIndex(cell, table);
    Array.from(table.rows).forEach((row) => {
      const refCell = row.cells[index] ?? row.cells[row.cells.length - 1];
      if (!refCell) return;
      const isHeader = refCell.tagName === "TH";
      const next = document.createElement(isHeader ? "th" : "td");
      if (isHeader) next.textContent = "Header";
      else next.innerHTML = "&nbsp;";
      if (after) refCell.after(next);
      else refCell.before(next);
    });
    setHasTable(true);
    emit();
  };

  const deleteColumn = () => {
    const resolved = resolveTable();
    if (!resolved) return;
    const { table, cell } = resolved;
    const index = columnIndex(cell, table);
    if (table.rows[0] && table.rows[0].cells.length <= 1) {
      table.remove();
      tableStateRef.current = null;
      setHasTable(false);
      emit();
      return;
    }
    Array.from(table.rows).forEach((row) => {
      if (row.cells[index]) row.cells[index].remove();
    });
    emit();
  };

  const deleteTable = () => {
    const resolved = resolveTable();
    if (!resolved) return;
    resolved.table.remove();
    tableStateRef.current = null;
    setHasTable(false);
    emit();
  };

  /** Document mode: a table is bordered (fee tables) unless its borders are turned off (a letterhead laid out in two columns). */
  const toggleBorders = () => {
    const resolved = resolveTable();
    if (!resolved) return;
    const table = resolved.table;
    table.style.border = /border:\s*none/.test(table.getAttribute("style") ?? "") ? "" : "none";
    if (!table.getAttribute("style")) table.removeAttribute("style");
    emit();
  };

  const groups = [...new Set((variables ?? []).map((v) => v.group))];
  const iconButton = "flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200";

  return (
    <div className="overflow-hidden rounded-md border border-background-300 bg-background-50">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-1 border-b border-background-200 bg-background-100 px-2 py-1.5">
        <button type="button" onMouseDown={stop} onClick={() => exec("undo")} aria-label="Undo" title="Undo" className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
          <i className="ri-arrow-go-back-line" aria-hidden="true" />
        </button>
        <button type="button" onMouseDown={stop} onClick={() => exec("redo")} aria-label="Redo" title="Redo" className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
          <i className="ri-arrow-go-forward-line" aria-hidden="true" />
        </button>

        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />

        <select
          aria-label="Text style"
          className={selectClass}
          defaultValue="p"
          onMouseDown={saveSelection}
          onChange={(e) => {
            restoreSelection();
            exec("formatBlock", e.target.value);
          }}
        >
          {BLOCK_OPTIONS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>

        {/* Documents print in one family (Arimo, Arial-compatible): no family choice that the PDF would not keep. */}
        {doc ? (
          <span className="px-1 text-xs text-foreground-600" title="The PDF prints all text in Arial (Arimo)" data-testid="document-font">Arial</span>
        ) : (
          <select
            aria-label="Font family"
            className={selectClass}
            defaultValue=""
            onMouseDown={saveSelection}
            onChange={(e) => {
              restoreSelection();
              if (e.target.value) exec("fontName", e.target.value);
            }}
          >
            {FONTS.map((f) => (
              <option key={f.label} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        )}

        {doc ? (
          <select aria-label="Font size" className={selectClass} value="" onMouseDown={saveSelection} onChange={(e) => { if (e.target.value) applySize(Number(e.target.value)); }}>
            <option value="">Size</option>
            {DOC_SIZES.map((pt) => <option key={pt} value={pt}>{pt} pt</option>)}
          </select>
        ) : (
          <select
            aria-label="Font size"
            className={selectClass}
            defaultValue="3"
            onMouseDown={saveSelection}
            onChange={(e) => {
              restoreSelection();
              exec("fontSize", e.target.value);
            }}
          >
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}

        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />

        {TEXT_TOOLS.map((tool) => (
          <button key={tool.command} type="button" onMouseDown={stop} onClick={() => exec(tool.command)} aria-label={tool.label} title={tool.label} className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
            <i className={tool.icon} aria-hidden="true" />
          </button>
        ))}
        {doc ? (
          <>
            <button type="button" onMouseDown={stop} onClick={() => exec("superscript")} aria-label="Superscript" title="Superscript" className={iconButton}><i className="ri-superscript" aria-hidden="true" /></button>
            <button type="button" onMouseDown={stop} onClick={() => exec("subscript")} aria-label="Subscript" title="Subscript" className={iconButton}><i className="ri-subscript" aria-hidden="true" /></button>
            <label className={`${iconButton} relative cursor-pointer`} title="Text colour" onMouseDown={saveSelection}>
              <i className="ri-font-color" aria-hidden="true" />
              <input type="color" aria-label="Text colour" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={(e) => { restoreSelection(); exec("foreColor", e.target.value); }} />
            </label>
            <label className={`${iconButton} relative cursor-pointer`} title="Highlight colour" onMouseDown={saveSelection}>
              <i className="ri-mark-pen-line" aria-hidden="true" />
              <input type="color" defaultValue="#ffff00" aria-label="Highlight colour" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" onChange={(e) => { restoreSelection(); exec("hiliteColor", e.target.value); }} />
            </label>
            <button type="button" onMouseDown={(e) => { saveSelection(); e.preventDefault(); }} onClick={() => setCharsOpen((v) => !v)} aria-label="Special characters" title="Special characters" className={iconButton}><i className="ri-omega" aria-hidden="true" /></button>
          </>
        ) : null}

        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />

        {LIST_TOOLS.map((tool) => (
          <button key={tool.command} type="button" onMouseDown={stop} onClick={() => exec(tool.command)} aria-label={tool.label} title={tool.label} className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
            <i className={tool.icon} aria-hidden="true" />
          </button>
        ))}
        {ALIGN_TOOLS.map((tool) => (
          <button key={tool.command} type="button" onMouseDown={stop} onClick={() => exec(tool.command)} aria-label={tool.label} title={tool.label} className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
            <i className={tool.icon} aria-hidden="true" />
          </button>
        ))}

        <span className="mx-1 h-5 w-px bg-background-300" aria-hidden="true" />

        <button
          type="button"
          onMouseDown={(e) => {
            saveSelection();
            e.preventDefault();
          }}
          onClick={() => setLinkOpen((v) => !v)}
          aria-label="Insert link"
          title="Insert link"
          className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200"
        >
          <i className="ri-link" aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={(e) => {
            saveSelection();
            e.preventDefault();
          }}
          onClick={() => setImgOpen((v) => !v)}
          aria-label="Insert image"
          title="Insert image"
          className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200"
        >
          <i className="ri-image-add-line" aria-hidden="true" />
        </button>
        <button type="button" onMouseDown={stop} onClick={() => exec("removeFormat")} aria-label="Clear formatting" title="Clear formatting" className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200">
          <i className="ri-format-clear" aria-hidden="true" />
        </button>
        <button
          type="button"
          onMouseDown={stop}
          onClick={() => setTableOpen((v) => !v)}
          aria-label="Table"
          title="Insert or edit a table"
          className="flex h-8 w-8 items-center justify-center rounded text-foreground-600 hover:bg-background-200"
        >
          <i className="ri-table-2" aria-hidden="true" />
        </button>
        {doc ? (
          <button type="button" onMouseDown={stop} onClick={toggleSource} aria-pressed={sourceOpen} aria-label="Source (HTML)" title="Source (HTML)" data-testid={testId ? `${testId}-source` : undefined}
            className={`${iconButton} ${sourceOpen ? "bg-primary-100 text-primary-800" : ""}`}><i className="ri-code-s-slash-line" aria-hidden="true" /></button>
        ) : null}
      </div>

      {charsOpen ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-background-200 bg-primary-50 px-2 py-2" role="group" aria-label="Special characters">
          {SPECIAL_CHARACTERS.map((ch) => (
            <button key={ch} type="button" onMouseDown={stop} onClick={() => insertText(ch)} className="h-7 w-7 rounded border border-background-300 bg-background-50 text-sm hover:bg-background-200">{ch}</button>
          ))}
        </div>
      ) : null}

      {/* Link / image insert rows */}
      {linkOpen ? (
        <div className="flex items-center gap-2 border-b border-background-200 bg-primary-50 px-2 py-2">
          <i className="ri-link text-foreground-500" aria-hidden="true" />
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyLink()}
            placeholder="https://example.com"
            className="flex-1 rounded border border-background-300 bg-background-50 px-2 py-1 text-xs focus:border-primary-400 focus:outline-none"
          />
          <button type="button" onClick={applyLink} className="rounded bg-primary-500 px-2.5 py-1 text-xs font-medium text-background-50">
            Add link
          </button>
        </div>
      ) : null}
      {imgOpen && doc ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-background-200 bg-primary-50 px-2 py-2">
          <i className="ri-image-line text-foreground-500" aria-hidden="true" />
          <label className="text-xs text-foreground-700">Width in pixels (optional) <input type="number" min={10} max={1200} value={imgWidth} onChange={(e) => setImgWidth(e.target.value)} className="ml-1 w-20 rounded border border-background-300 bg-background-50 px-2 py-1 text-xs" /></label>
          <input type="file" accept="image/png,image/jpeg" aria-label="Picture to insert" onChange={(e) => uploadImage(e.target.files?.[0])} className="text-xs" />
          {imgError ? <span role="alert" className="text-xs text-red-700">{imgError}</span> : <span className="text-xs text-foreground-500">PNG or JPEG, stored inside the template.</span>}
        </div>
      ) : null}
      {imgOpen && !doc ? (
        <div className="flex items-center gap-2 border-b border-background-200 bg-primary-50 px-2 py-2">
          <i className="ri-image-line text-foreground-500" aria-hidden="true" />
          <input
            autoFocus
            value={imgUrl}
            onChange={(e) => setImgUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && applyImage()}
            placeholder="Image URL https://…"
            className="flex-1 rounded border border-background-300 bg-background-50 px-2 py-1 text-xs focus:border-primary-400 focus:outline-none"
          />
          <button type="button" onClick={applyImage} className="rounded bg-primary-500 px-2.5 py-1 text-xs font-medium text-background-50">
            Insert
          </button>
        </div>
      ) : null}

      {tableOpen ? (
        <div className="border-b border-background-200 bg-primary-50 px-2 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-foreground-600">Table</span>
            <input
              type="number"
              min={1}
              max={20}
              value={tableRows}
              onChange={(e) => setTableRows(Number(e.target.value) || 1)}
              aria-label="Rows"
              className="w-14 rounded border border-background-300 bg-background-50 px-2 py-1 text-xs focus:border-primary-400 focus:outline-none"
            />
            <span className="text-xs text-foreground-500">&times;</span>
            <input
              type="number"
              min={1}
              max={12}
              value={tableCols}
              onChange={(e) => setTableCols(Number(e.target.value) || 1)}
              aria-label="Columns"
              className="w-14 rounded border border-background-300 bg-background-50 px-2 py-1 text-xs focus:border-primary-400 focus:outline-none"
            />
            <button type="button" onClick={insertTable} className="rounded bg-primary-500 px-2.5 py-1 text-xs font-medium text-background-50">
              Insert table
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-background-200 pt-2">
            <span className="mr-1 flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-foreground-500">
              <i className="ri-table-2" aria-hidden="true" />
              {hasTable ? "Edit table" : "No table yet"}
            </span>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={() => addRow(false)} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Add row &uarr;</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={() => addRow(true)} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Add row &darr;</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={() => addColumn(false)} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Add col &larr;</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={() => addColumn(true)} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Add col &rarr;</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={deleteRow} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Delete row</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={deleteColumn} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Delete column</button>
            <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={deleteTable} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-primary-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Delete table</button>
            {doc ? <button type="button" disabled={!hasTable} onMouseDown={stop} onClick={toggleBorders} className="rounded border border-background-300 bg-background-50 px-2 py-1 text-xs text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40">Borders on / off</button> : null}
            <span className="ml-1 text-[11px] text-foreground-400">Tip: click a cell first to target that row/column.</span>
          </div>
        </div>
      ) : null}

      {/* Editable area (document mode: with the variable picker beside it) */}
      <div className={doc && variables?.length ? "grid lg:grid-cols-[1fr_220px]" : ""}>
        <div className="relative min-w-0">
          {(!value || value === "<p></p>") && !focused && !sourceOpen ? (
            <span className="pointer-events-none absolute left-3 top-3 text-sm text-foreground-400">{placeholder}</span>
          ) : null}
          {sourceOpen ? (
            <textarea value={sourceText} onChange={(e) => setSourceText(e.target.value)} aria-label={`${label} (HTML source)`} spellCheck={false} data-testid={testId ? `${testId}-source-text` : undefined}
              className="block w-full bg-background-50 px-3 py-3 font-mono text-xs text-foreground-900 outline-none" style={{ minHeight }} />
          ) : null}
          <div
            ref={ref}
            contentEditable
            role="textbox"
            aria-multiline="true"
            aria-label={label}
            data-testid={testId}
            suppressContentEditableWarning
            onInput={emit}
            onPaste={pasteClean}
            onMouseUp={() => { syncActiveTable(); saveSelection(); }}
            onKeyUp={() => { syncActiveTable(); saveSelection(); }}
            onBlur={() => {
              setFocused(false);
              emit();
            }}
            onFocus={() => setFocused(true)}
            className={`rte-content px-3 py-3 outline-none ${doc ? "doc-content overflow-y-auto bg-white" : "text-sm leading-relaxed text-foreground-900"} ${sourceOpen ? "hidden" : ""}`}
            style={doc ? { minHeight, maxHeight: "60vh" } : { minHeight }}
          />
        </div>
        {doc && variables?.length ? (
          <aside className="border-t border-background-200 bg-background-100 p-2 lg:border-l lg:border-t-0" aria-label="Variables">
            <p className="text-[13px] font-semibold text-foreground-900">Variables</p>
            <p className="mb-2 text-[11px] text-foreground-600">Click to insert at the cursor. Any other [text in square brackets] is filled in by the signer.</p>
            <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {groups.map((group) => (
                <div key={group}>
                  <p className="mb-1 text-[10px] font-bold uppercase tracking-wide text-foreground-500">{group}</p>
                  <ul className="space-y-1">
                    {variables.filter((v) => v.group === group).map((v) => (
                      <li key={v.name}>
                        <button type="button" onMouseDown={stop} onClick={() => insertText(`[${v.name}]`)} title={`${v.description}. Example: ${v.sample}`} data-testid={`variable-${v.name.replace(/\s+/g, "-").toLowerCase()}`}
                          className="w-full rounded border border-background-300 bg-background-50 px-2 py-1 text-left text-xs hover:border-primary-300 hover:bg-primary-50">
                          <code className="text-[11px] text-foreground-900">[{v.name}]</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}