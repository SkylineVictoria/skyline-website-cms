import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import PdfPages from "./PdfPages";
import type { SignFieldType } from "@/lib/signingApi";

export interface EditorField { key: string; type: SignFieldType; owner: string; page: number; x: number; y: number; w: number; h: number; required: boolean; label: string; value?: string }
/** Who a field belongs to: a signer (or a signer role on a template), or the sender for printed text. */
export interface EditorOwner { id: string; label: string; textOnly?: boolean }

const FIELD_KINDS: Record<SignFieldType, { label: string; icon: string; w: number; h: number }> = {
  signature: { label: "Signature", icon: "ri-quill-pen-line", w: 0.28, h: 0.06 }, initials: { label: "Initials", icon: "ri-font-size", w: 0.1, h: 0.045 },
  date: { label: "Date signed", icon: "ri-calendar-line", w: 0.18, h: 0.03 }, name: { label: "Name", icon: "ri-user-line", w: 0.25, h: 0.03 },
  text: { label: "Text", icon: "ri-text", w: 0.3, h: 0.03 }, checkbox: { label: "Checkbox", icon: "ri-checkbox-line", w: 0.03, h: 0.022 },
};
const COLOURS = ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#dc2626", "#4d7c0f", "#9333ea", "#475569"];
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));
const newKey = () => `f${Math.random().toString(36).slice(2, 10)}`;

/** Auto-scroll zone at the top and bottom of the pages area, and the fastest scroll (px per frame) right at the edge. */
const EDGE = 60, MAX_SPEED = 20;
/** Positions snap to 4 CSS px on the page; a pointer that moves less than this is a click, not a drag. */
const SNAP = 4, CLICK_SLOP = 4;
/** Smallest field, as a fraction of the page (as before). */
const MIN_W = 0.02, MIN_H = 0.012;
const snap = (px: number) => Math.round(px / SNAP) * SNAP;
const DROP_OUTLINE = "2px solid rgba(37, 99, 235, 0.55)";

interface Drag {
  mode: "move" | "resize" | "new";
  pointerId: number;
  /** The field being moved or resized. */
  key?: string;
  /** The field type being placed from the panel. */
  type?: SignFieldType;
  /** The element that follows the pointer: the field itself, or the ghost of a new field. */
  el: HTMLElement;
  /** The element holding the pointer capture. */
  captor: HTMLElement;
  start: { x: number; y: number };
  last: { x: number; y: number };
  scrollStart: number;
  /** move / resize: the field's size in CSS px when the drag began. */
  size: { width: number; height: number };
  /** move: the field's top-left and the pages' extent in the pages area's content coordinates (scroll included), so a moved field
   * never leaves the pages (it would otherwise grow the scroll area and auto-scroll would never reach the end). */
  box: { left: number; top: number; minLeft: number; maxLeft: number; minTop: number; maxTop: number };
  moved: boolean;
  frame: number;
  target: HTMLElement | null;
  cleanup: () => void;
}

/**
 * Places fields on the pages of a PDF. Drag a field type onto a page (or choose a type and then click or tap the page), drag a placed field
 * to move it (also onto another page), drag its corner to resize it. Every field belongs to the signer chosen in "Fields for"; positions are
 * fractions of the page, so they hold at any zoom and in the final PDF.
 *
 * Dragging uses pointer events with pointer capture (mouse, pen and touch), moves the field with a transform on its DOM node in a
 * requestAnimationFrame loop (no React render per move), scrolls the pages area when the pointer is near its top or bottom edge, and
 * commits the position once, on drop, to the page under the field.
 */
export default function FieldEditor({ source, owners, fields, onChange }: { source: string | Uint8Array; owners: EditorOwner[]; fields: EditorField[]; onChange: (fields: EditorField[]) => void }) {
  const [owner, setOwner] = useState(owners[0]?.id ?? "");
  const [armed, setArmed] = useState<SignFieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const latest = useRef(fields); latest.current = fields;
  const scroller = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  // Elements whose drag styles are cleared once the new position has been rendered (no jump back for a frame).
  const settle = useRef<HTMLElement[]>([]);
  const suppressClick = useRef(false);
  const current = owners.find((o) => o.id === owner) ?? owners[0];
  const colourOf = (id: string) => COLOURS[Math.max(0, owners.findIndex((o) => o.id === id)) % COLOURS.length];
  const chosen = fields.find((f) => f.key === selected) ?? null;

  useLayoutEffect(() => {
    for (const el of settle.current) clearDragStyles(el);
    settle.current = [];
  }, [fields]);

  const place = (type: SignFieldType, page: number, fx: number, fy: number) => {
    if (!current) return;
    const kind = FIELD_KINDS[current.textOnly ? "text" : type];
    const field: EditorField = { key: newKey(), type: current.textOnly ? "text" : type, owner: current.id, page, w: kind.w, h: kind.h, x: clamp(fx - kind.w / 2, 0, 1 - kind.w), y: clamp(fy - kind.h / 2, 0, 1 - kind.h),
      required: true, label: "", ...(current.textOnly ? { value: "" } : {}) };
    onChange([...latest.current, field]); setSelected(field.key); setArmed(null);
  };
  const click = (event: ReactMouseEvent<HTMLDivElement>, page: number) => {
    if (event.target !== event.currentTarget) return;
    if (!armed) { setSelected(null); return; }
    const box = event.currentTarget.getBoundingClientRect();
    place(armed, page, (event.clientX - box.left) / box.width, (event.clientY - box.top) / box.height);
  };

  const pageElements = () => Array.from(scroller.current?.querySelectorAll<HTMLElement>("[data-pdf-page]") ?? []);
  const pageElement = (page: number) => scroller.current?.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`) ?? null;
  /** The page under a point, or (for a field dropped in the gap between pages) the nearest page vertically. */
  const pageNear = (x: number, y: number, nearest: boolean): HTMLElement | null => {
    let best: HTMLElement | null = null, bestDistance = Infinity;
    for (const page of pageElements()) {
      const r = page.getBoundingClientRect();
      const inside = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      if (inside) return page;
      const distance = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      if (nearest && distance < bestDistance) { bestDistance = distance; best = page; }
    }
    return best;
  };
  const highlight = (d: Drag, page: HTMLElement | null) => {
    if (d.target === page) return;
    if (d.target) d.target.style.outline = "";
    if (page) page.style.outline = DROP_OUTLINE;
    d.target = page;
  };

  // One frame of a drag: scroll near the edges, then move / resize / follow with the scroll delta included.
  const frame = () => {
    const d = drag.current, sc = scroller.current;
    if (!d || !sc) return;
    const r = sc.getBoundingClientRect();
    const overPages = d.last.x >= r.left && d.last.x <= r.right;
    if (d.moved && (d.mode !== "new" || overPages)) {
      let speed = 0;
      if (d.last.y < r.top + EDGE) speed = -Math.ceil(MAX_SPEED * Math.min(1, (r.top + EDGE - d.last.y) / EDGE));
      else if (d.last.y > r.bottom - EDGE) speed = Math.ceil(MAX_SPEED * Math.min(1, (d.last.y - (r.bottom - EDGE)) / EDGE));
      if (speed) sc.scrollTop += speed;
    }
    let dx = d.last.x - d.start.x, dy = d.last.y - d.start.y + (sc.scrollTop - d.scrollStart);
    if (d.mode === "move") {
      dx = clamp(d.box.left + dx, d.box.minLeft, d.box.maxLeft) - d.box.left;
      dy = clamp(d.box.top + dy, d.box.minTop, d.box.maxTop) - d.box.top;
      d.el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
      const box = d.el.getBoundingClientRect();
      highlight(d, d.moved ? pageNear(box.left + box.width / 2, box.top + box.height / 2, true) : null);
    } else if (d.mode === "resize") {
      const page = d.el.closest<HTMLElement>("[data-pdf-page]");
      const pr = page?.getBoundingClientRect(), fr = d.el.getBoundingClientRect();
      if (pr) {
        d.el.style.width = `${clamp(d.size.width + dx, MIN_W * pr.width, pr.right - fr.left)}px`;
        d.el.style.height = `${clamp(d.size.height + dy, MIN_H * pr.height, pr.bottom - fr.top)}px`;
      }
    } else {
      d.el.style.transform = `translate3d(${d.last.x - d.el.offsetWidth / 2}px, ${d.last.y - d.el.offsetHeight / 2}px, 0)`;
      d.el.style.visibility = d.moved ? "visible" : "hidden";
      highlight(d, d.moved ? pageNear(d.last.x, d.last.y, false) : null);
    }
    d.frame = requestAnimationFrame(frame);
  };

  const begin = (event: ReactPointerEvent<HTMLElement>, init: Pick<Drag, "mode" | "el" | "key" | "type">) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if (drag.current) finish(false);
    const captor = event.currentTarget;
    const sc = scroller.current;
    try { captor.setPointerCapture(event.pointerId); } catch { /* the pointer is gone */ }
    const onMove = (e: PointerEvent) => {
      const d = drag.current; if (!d || e.pointerId !== d.pointerId) return;
      d.last = { x: e.clientX, y: e.clientY };
      if (!d.moved && Math.hypot(d.last.x - d.start.x, d.last.y - d.start.y) > CLICK_SLOP) d.moved = true;
    };
    const onUp = (e: PointerEvent) => { if (drag.current && e.pointerId === drag.current.pointerId) { drag.current.last = { x: e.clientX, y: e.clientY }; finish(true); } };
    const onCancel = (e: PointerEvent) => { if (drag.current && e.pointerId === drag.current.pointerId) finish(false); };
    captor.addEventListener("pointermove", onMove);
    captor.addEventListener("pointerup", onUp);
    captor.addEventListener("pointercancel", onCancel);
    const box = init.el.getBoundingClientRect();
    // The pages' extent in content coordinates (x: client px, the area does not scroll sideways; y: px from the top of the content).
    const area = sc?.getBoundingClientRect(), scrollTop = sc?.scrollTop ?? 0;
    const pageBoxes = pageElements().map((p) => p.getBoundingClientRect());
    const toContent = (clientY: number) => clientY - (area?.top ?? 0) + scrollTop;
    const extent = pageBoxes.length
      ? { minLeft: Math.min(...pageBoxes.map((r) => r.left)), maxRight: Math.max(...pageBoxes.map((r) => r.right)),
          minTop: toContent(pageBoxes[0].top), maxBottom: toContent(pageBoxes[pageBoxes.length - 1].bottom) }
      : { minLeft: box.left, maxRight: box.right, minTop: toContent(box.top), maxBottom: toContent(box.bottom) };
    const fieldBox = { left: box.left, top: toContent(box.top), minLeft: extent.minLeft, maxLeft: extent.maxRight - box.width,
      minTop: extent.minTop, maxTop: extent.maxBottom - box.height };
    init.el.style.willChange = init.mode === "resize" ? "width, height" : "transform";
    if (init.mode !== "new") init.el.style.zIndex = "30";
    drag.current = {
      ...init, pointerId: event.pointerId, captor, start: { x: event.clientX, y: event.clientY }, last: { x: event.clientX, y: event.clientY },
      scrollStart: scrollTop, size: { width: box.width, height: box.height }, box: fieldBox, moved: false, frame: 0, target: null,
      cleanup: () => {
        captor.removeEventListener("pointermove", onMove); captor.removeEventListener("pointerup", onUp); captor.removeEventListener("pointercancel", onCancel);
        try { if (captor.hasPointerCapture(event.pointerId)) captor.releasePointerCapture(event.pointerId); } catch { /* released */ }
      },
    };
    drag.current.frame = requestAnimationFrame(frame);
  };

  // Drop: commit the position once, to the page under the field (move), within its page (resize), or under the pointer (new field).
  const finish = (commit: boolean) => {
    const d = drag.current; if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    d.cleanup();
    if (d.target) d.target.style.outline = "";
    if (d.mode === "new") {
      d.el.remove();
      if (!d.moved) return; // a click: the button's onClick arms the type for click-to-place
      suppressClick.current = true;
      const page = commit ? pageNear(d.last.x, d.last.y, false) : null;
      if (!page || !d.type) return;
      const pr = page.getBoundingClientRect();
      place(d.type, Number(page.dataset.pdfPage), (d.last.x - pr.left) / pr.width, (d.last.y - pr.top) / pr.height);
      return;
    }
    const field = latest.current.find((f) => f.key === d.key);
    // React owns left / top / width / height (percentages); the drag only adds a transform or, for a resize, px sizes, which go back
    // to the field's percentages when nothing is committed.
    const restore = () => { clearDragStyles(d.el); if (d.mode === "resize" && field) { d.el.style.width = `${field.w * 100}%`; d.el.style.height = `${field.h * 100}%`; } };
    if (!commit || !d.moved || !field) { restore(); return; }
    if (d.mode === "move") {
      const box = d.el.getBoundingClientRect();
      const page = pageNear(box.left + box.width / 2, box.top + box.height / 2, true);
      if (!page) { restore(); return; }
      const pr = page.getBoundingClientRect();
      const x = clamp(snap(box.left - pr.left) / pr.width, 0, 1 - field.w), y = clamp(snap(box.top - pr.top) / pr.height, 0, 1 - field.h);
      settle.current.push(d.el);
      onChange(latest.current.map((f) => f.key === field.key ? { ...f, page: Number(page.dataset.pdfPage), x, y } : f));
    } else {
      const pr = d.el.closest<HTMLElement>("[data-pdf-page]")?.getBoundingClientRect();
      if (!pr) { restore(); return; }
      const w = clamp(snap(d.el.offsetWidth) / pr.width, MIN_W, 1 - field.x), h = clamp(snap(d.el.offsetHeight) / pr.height, MIN_H, 1 - field.y);
      // The committed size as the same percentages React renders next (so nothing jumps and nothing is left in px).
      d.el.style.width = `${w * 100}%`; d.el.style.height = `${h * 100}%`;
      settle.current.push(d.el);
      onChange(latest.current.map((f) => f.key === field.key ? { ...f, w, h } : f));
    }
  };
  useEffect(() => () => finish(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const startMove = (event: ReactPointerEvent<HTMLElement>, field: EditorField) => {
    event.preventDefault(); event.stopPropagation(); setSelected(field.key);
    begin(event, { mode: "move", el: event.currentTarget, key: field.key });
  };
  const startResize = (event: ReactPointerEvent<HTMLElement>, field: EditorField) => {
    event.preventDefault(); event.stopPropagation(); setSelected(field.key);
    const el = event.currentTarget.parentElement; if (el) begin(event, { mode: "resize", el, key: field.key });
  };
  // A new field from the panel: a ghost the size the field will have on the first page follows the pointer.
  const startNew = (event: ReactPointerEvent<HTMLElement>, type: SignFieldType) => {
    if (!current) return;
    const kind = FIELD_KINDS[current.textOnly ? "text" : type];
    const page = pageElements()[0]?.getBoundingClientRect();
    const colour = colourOf(current.id);
    const ghost = document.createElement("div");
    Object.assign(ghost.style, { position: "fixed", left: "0", top: "0", zIndex: "100", pointerEvents: "none", visibility: "hidden",
      width: `${(page?.width ?? 600) * kind.w}px`, height: `${(page?.height ?? 850) * kind.h}px`, border: `2px dashed ${colour}`, background: `${colour}33`,
      color: colour, font: "500 10px/1 sans-serif", display: "flex", alignItems: "center", padding: "0 4px", borderRadius: "2px", willChange: "transform" });
    ghost.textContent = current.textOnly ? "Printed text" : kind.label;
    ghost.setAttribute("data-testid", "field-ghost");
    document.body.appendChild(ghost);
    begin(event, { mode: "new", el: ghost, type });
  };

  // Keyboard: arrows nudge the selected field by 1 px (Shift: 10 px); Delete / Backspace removes it; Escape stops click-to-place.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName))) return;
      if (event.key === "Escape") { setArmed(null); return; }
      const field = latest.current.find((f) => f.key === selected); if (!field) return;
      if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); onChange(latest.current.filter((f) => f.key !== field.key)); setSelected(null); return; }
      const step = event.shiftKey ? 10 : 1;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      const pr = move && pageElement(field.page)?.getBoundingClientRect();
      if (!move || !pr) return;
      event.preventDefault();
      onChange(latest.current.map((f) => f.key === field.key ? { ...f, x: clamp(f.x + move[0] / pr.width, 0, 1 - f.w), y: clamp(f.y + move[1] / pr.height, 0, 1 - f.h) } : f));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onChange]);

  const update = (patch: Partial<EditorField>) => { if (chosen) onChange(fields.map((f) => f.key === chosen.key ? { ...f, ...patch } : f)); };

  // The pages area is the only scrolling element; the panel scrolls on its own; the modal header and footer stay put.
  return <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row" data-testid="field-editor">
    <aside className="max-h-[38%] shrink-0 space-y-4 overflow-y-auto pr-1 lg:max-h-none lg:w-[260px]" data-testid="field-panel">
      <label className="block text-label font-medium text-foreground-800">Fields for
        <select value={current?.id ?? ""} onChange={(e) => { setOwner(e.target.value); setArmed(null); }} className="mt-1 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm" data-testid="field-owner">
          {owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2 text-xs text-foreground-600"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: colourOf(current?.id ?? "") }} /> Fields of this person are shown in this colour.</div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
        {(Object.keys(FIELD_KINDS) as SignFieldType[]).filter((type) => !current?.textOnly || type === "text").map((type) => <button key={type} type="button" data-testid={`field-kind-${type}`}
          onPointerDown={(e) => startNew(e, type)}
          onClick={() => { if (suppressClick.current) { suppressClick.current = false; return; } setArmed(armed === type ? null : type); }}
          className={`flex cursor-grab touch-none select-none items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${armed === type ? "border-primary-500 bg-primary-50" : "border-background-300 bg-background-50 hover:bg-background-100"}`}>
          <i className={`${FIELD_KINDS[type].icon} text-base`} aria-hidden="true" />{current?.textOnly ? "Printed text" : FIELD_KINDS[type].label}</button>)}
      </div>
      <p className="text-xs text-foreground-600">{armed ? "Now click the place on the page where it goes." : "Drag a field onto a page, or choose one and then click the page. Drag a placed field to move it (also to another page) and its corner to resize it. Arrow keys nudge the selected field; Delete removes it."}</p>
      {chosen && <div className="space-y-3 rounded-md border border-background-300 p-3 text-sm" data-testid="field-details">
        <p className="font-semibold">{FIELD_KINDS[chosen.type].label} · page {chosen.page}</p>
        <label className="block text-xs">Belongs to
          <select value={chosen.owner} onChange={(e) => update({ owner: e.target.value })} className="mt-1 w-full rounded border border-background-300 px-2 py-1.5 text-sm">
            {owners.filter((o) => !o.textOnly || chosen.type === "text").map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select></label>
        {owners.find((o) => o.id === chosen.owner)?.textOnly
          ? <label className="block text-xs">Text to print (variables allowed)<input value={chosen.value ?? ""} maxLength={500} onChange={(e) => update({ value: e.target.value })} placeholder="{{student.full_name}}" className="mt-1 w-full rounded border border-background-300 px-2 py-1.5 text-sm" /></label>
          : <>{(chosen.type === "text" || chosen.type === "checkbox") && <label className="block text-xs">Label shown to the signer<input value={chosen.label} maxLength={120} onChange={(e) => update({ label: e.target.value })} className="mt-1 w-full rounded border border-background-300 px-2 py-1.5 text-sm" /></label>}
            {(chosen.type === "text" || chosen.type === "checkbox") && <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={chosen.required} onChange={(e) => update({ required: e.target.checked })} /> Required</label>}</>}
        <button type="button" onClick={() => { onChange(fields.filter((f) => f.key !== chosen.key)); setSelected(null); }} className="text-xs font-medium text-red-700 underline">Remove this field</button>
      </div>}
      <p className="text-xs text-foreground-500">{fields.length} field{fields.length === 1 ? "" : "s"} placed.</p>
    </aside>
    <div ref={scroller} data-testid="field-pages" className={`min-h-[240px] flex-1 overflow-y-auto overscroll-contain rounded-md bg-background-200 p-3 ${armed ? "cursor-crosshair" : ""}`}>
      <PdfPages source={source} maxWidth={820} overlay={(page) => <div className="absolute inset-0" data-testid={`field-page-${page}`} onClick={(e) => click(e, page)}>
        {fields.filter((f) => f.page === page).map((f) => {
          const colour = colourOf(f.owner), active = f.key === selected;
          return <div key={f.key} data-testid="placed-field" data-field-type={f.type} data-field-key={f.key} onPointerDown={(e) => startMove(e, f)}
            className="absolute flex cursor-move touch-none select-none items-center overflow-hidden rounded-sm text-2xs font-medium leading-none"
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, border: `${active ? 2 : 1}px ${active ? "solid" : "dashed"} ${colour}`, background: `${colour}22`, color: colour }}>
            <span className="truncate px-1">{f.type === "checkbox" ? "☐" : f.value || f.label || FIELD_KINDS[f.type].label}</span>
            <span onPointerDown={(e) => startResize(e, f)} aria-hidden="true" data-testid="field-resize" className="absolute bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize touch-none" style={{ background: colour }} />
          </div>;
        })}
      </div>} />
    </div>
  </div>;
}

/** Drops what a drag added (never React's own left / top / width / height). */
function clearDragStyles(el: HTMLElement) {
  el.style.transform = ""; el.style.willChange = ""; el.style.zIndex = "";
}
