import { useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const newKey = () => `f${Math.random().toString(36).slice(2, 10)}`;

/**
 * Places fields on the pages of a PDF. Drag a field type onto a page (or choose a type and then click or tap the page), drag a placed field
 * to move it, drag its corner to resize it. Every field belongs to the signer chosen in "Fields for"; positions are fractions of the page,
 * so they hold at any zoom and in the final PDF.
 */
export default function FieldEditor({ source, owners, fields, onChange }: { source: string | Uint8Array; owners: EditorOwner[]; fields: EditorField[]; onChange: (fields: EditorField[]) => void }) {
  const [owner, setOwner] = useState(owners[0]?.id ?? "");
  const [armed, setArmed] = useState<SignFieldType | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const latest = useRef(fields); latest.current = fields;
  const current = owners.find((o) => o.id === owner) ?? owners[0];
  const colourOf = (id: string) => COLOURS[Math.max(0, owners.findIndex((o) => o.id === id)) % COLOURS.length];
  const chosen = fields.find((f) => f.key === selected) ?? null;

  const place = (type: SignFieldType, page: number, fx: number, fy: number) => {
    if (!current) return;
    const kind = FIELD_KINDS[current.textOnly ? "text" : type];
    const field: EditorField = { key: newKey(), type: current.textOnly ? "text" : type, owner: current.id, page, w: kind.w, h: kind.h, x: clamp(fx - kind.w / 2, 0, 1 - kind.w), y: clamp(fy - kind.h / 2, 0, 1 - kind.h),
      required: true, label: "", ...(current.textOnly ? { value: "" } : {}) };
    onChange([...latest.current, field]); setSelected(field.key); setArmed(null);
  };
  const pointOn = (event: { clientX: number; clientY: number; currentTarget: Element }) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { fx: (event.clientX - box.left) / box.width, fy: (event.clientY - box.top) / box.height };
  };
  const drop = (event: ReactDragEvent<HTMLDivElement>, page: number) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("text/slit-field") as SignFieldType;
    if (!FIELD_KINDS[type]) return;
    const { fx, fy } = pointOn(event); place(type, page, fx, fy);
  };
  const click = (event: ReactMouseEvent<HTMLDivElement>, page: number) => {
    if (event.target !== event.currentTarget) return;
    if (!armed) { setSelected(null); return; }
    const { fx, fy } = pointOn(event); place(armed, page, fx, fy);
  };
  // Move or resize with the pointer (mouse, pen or touch): the change is measured against the page the field is on.
  const startDrag = (event: ReactPointerEvent<HTMLElement>, field: EditorField, mode: "move" | "resize") => {
    event.preventDefault(); event.stopPropagation(); setSelected(field.key);
    const page = (event.currentTarget.closest("[data-pdf-page]") as HTMLElement | null)?.getBoundingClientRect();
    if (!page) return;
    const start = { x: event.clientX, y: event.clientY };
    const move = (e: PointerEvent) => {
      const dx = (e.clientX - start.x) / page.width, dy = (e.clientY - start.y) / page.height;
      onChange(latest.current.map((f) => f.key !== field.key ? f : mode === "move"
        ? { ...f, x: clamp(field.x + dx, 0, 1 - f.w), y: clamp(field.y + dy, 0, 1 - f.h) }
        : { ...f, w: clamp(field.w + dx, 0.02, 1 - f.x), h: clamp(field.h + dy, 0.012, 1 - f.y) }));
    };
    const stop = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
  };
  const update = (patch: Partial<EditorField>) => { if (chosen) onChange(fields.map((f) => f.key === chosen.key ? { ...f, ...patch } : f)); };

  return <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
    <aside className="space-y-4 lg:sticky lg:top-0 lg:self-start">
      <label className="block text-[13px] font-medium text-foreground-800">Fields for
        <select value={current?.id ?? ""} onChange={(e) => { setOwner(e.target.value); setArmed(null); }} className="mt-1 w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm" data-testid="field-owner">
          {owners.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2 text-xs text-foreground-600"><span className="inline-block h-3 w-3 rounded-sm" style={{ background: colourOf(current?.id ?? "") }} /> Fields of this person are shown in this colour.</div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-1">
        {(Object.keys(FIELD_KINDS) as SignFieldType[]).filter((type) => !current?.textOnly || type === "text").map((type) => <button key={type} type="button" draggable data-testid={`field-kind-${type}`}
          onDragStart={(e) => { e.dataTransfer.setData("text/slit-field", type); e.dataTransfer.effectAllowed = "copy"; }} onClick={() => setArmed(armed === type ? null : type)}
          className={`flex cursor-grab items-center gap-2 rounded-md border px-3 py-2 text-left text-sm ${armed === type ? "border-primary-500 bg-primary-50" : "border-background-300 bg-background-50 hover:bg-background-100"}`}>
          <i className={`${FIELD_KINDS[type].icon} text-base`} aria-hidden="true" />{current?.textOnly ? "Printed text" : FIELD_KINDS[type].label}</button>)}
      </div>
      <p className="text-xs text-foreground-600">{armed ? "Now click the place on the page where it goes." : "Drag a field onto a page, or choose one and then click the page. Drag a placed field to move it and its corner to resize it."}</p>
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
    <div className={`max-h-[70vh] overflow-y-auto rounded-md bg-background-200 p-3 ${armed ? "cursor-crosshair" : ""}`}>
      <PdfPages source={source} maxWidth={820} overlay={(page) => <div className="absolute inset-0" data-testid={`field-page-${page}`} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={(e) => drop(e, page)} onClick={(e) => click(e, page)}>
        {fields.filter((f) => f.page === page).map((f) => {
          const colour = colourOf(f.owner), active = f.key === selected;
          return <div key={f.key} data-testid="placed-field" data-field-type={f.type} onPointerDown={(e) => startDrag(e, f, "move")}
            className="absolute flex cursor-move touch-none select-none items-center overflow-hidden rounded-sm text-[10px] font-medium leading-none"
            style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%`, border: `${active ? 2 : 1}px ${active ? "solid" : "dashed"} ${colour}`, background: `${colour}22`, color: colour }}>
            <span className="truncate px-1">{f.type === "checkbox" ? "☐" : f.value || f.label || FIELD_KINDS[f.type].label}</span>
            <span onPointerDown={(e) => startDrag(e, f, "resize")} aria-hidden="true" className="absolute bottom-0 right-0 h-2.5 w-2.5 cursor-nwse-resize" style={{ background: colour }} />
          </div>;
        })}
      </div>} />
    </div>
  </div>;
}
