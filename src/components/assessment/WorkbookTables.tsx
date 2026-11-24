/**
 * ASM-WORKBOOK items 3 and 7 on screen, drawn from the shared layout (src/lib/assessment/workbookLayout.ts) that "Export as workbook
 * PDF" prints: the workbook's two-column tables with tick boxes, the student / trainer / qualification details, and Appendix A –
 * Reasonable Adjustments. Used by the student's assessment page, the wizard's Review step and the trainer's view.
 */
import type { ReactNode } from "react";
import type { Question } from "@/lib/assessment/types";
import { adjustmentLayout, coverLayout, detailRows, PAGE_H, PAGE_W, qualificationRows, type LayoutCell, type WorkbookDetails, type WorkbookUnitInfo } from "@/lib/assessment/workbookLayout";
import type { WorkbookLetterhead } from "@/lib/assessment/workbookExport";

/**
 * ASM-HEADER: the master workbook's page header: the header picture on the left, the address block on the right, a line under it.
 * The same header the PDF prints (Assessments > Settings > Workbook header; no legal-name line).
 */
export function WorkbookHeader({ head, className = "" }: { head: WorkbookLetterhead | null; className?: string }) {
  return (
    <header className={`flex items-start justify-between gap-4 border-b border-neutral-300 pb-3 ${className}`} data-testid="workbook-header">
      <div className="min-h-[3.5rem] min-w-0 flex-1">{head?.logoUrl ? <img src={head.logoUrl} alt={head.name} className="max-h-16 max-w-[min(17rem,100%)] object-contain object-left" /> : null}</div>
      <div className="shrink-0 text-right text-[11px] leading-snug text-neutral-500">{(head?.lines ?? []).map((l) => <p key={l}>{l}</p>)}</div>
    </header>
  );
}

/** ASM-COVER: the workbook's first page, drawn from the same coverLayout the PDF uses (as SVG, in page points). */
export function WorkbookCover({ unit, title, logoUrl, student }: { unit: WorkbookUnitInfo | null; title: string; logoUrl: string | null; student?: { name: string; ref: string } | null }) {
  const c = coverLayout({ unit, title, student });
  const t = c.table;
  return (
    <svg viewBox={`0 0 ${PAGE_W} ${PAGE_H}`} className="block h-auto w-full" role="img" aria-label={`Cover: Student workbook, ${c.title.text}`} data-testid="workbook-cover">
      {c.shapes.map((r, i) => <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill={r.fill} />)}
      <path d={c.wave.path} fill={c.wave.fill} />
      {c.lines.map((l, i) => <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={l.stroke} strokeWidth={l.width} />)}
      {logoUrl ? <>
        <rect x={c.logo.x} y={c.logo.y} width={c.logo.w} height={c.logo.h} fill="#ffffff" />
        <image href={logoUrl} x={c.logo.x + c.logo.pad} y={c.logo.y + c.logo.pad} width={c.logo.w - 2 * c.logo.pad} height={c.logo.h - 2 * c.logo.pad} preserveAspectRatio="xMinYMid meet" />
      </> : null}
      <text x={PAGE_W / 2} y={c.band.y} textAnchor="middle" dominantBaseline="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={c.band.size} letterSpacing={c.band.spacing} fill={c.band.color}>{c.band.text}</text>
      <text x={PAGE_W / 2} y={c.title.y} textAnchor="middle" fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={c.title.size} fill={c.title.color}>{c.title.text}</text>
      {t.rows.map(([label, value], i) => {
        const y = t.y + i * t.rowH;
        return (
          <g key={label}>
            <rect x={t.x} y={y} width={t.labelW} height={t.rowH} fill={t.label} stroke={t.border} strokeWidth={0.8} />
            <rect x={t.x + t.labelW} y={y} width={t.w - t.labelW} height={t.rowH} fill={t.value} stroke={t.border} strokeWidth={0.8} />
            <text x={t.x + 8} y={y + t.rowH / 2 + 3.5} fontFamily="Helvetica, Arial, sans-serif" fontWeight="700" fontSize={10} fill="#1a1c21">{label}</text>
            {value ? <text x={t.x + t.labelW + 8} y={y + t.rowH / 2 + 3.5} fontFamily="Helvetica, Arial, sans-serif" fontSize={10} fill="#1a1c21">{value}</text>
              : <line x1={t.x + t.labelW + 8} y1={y + t.rowH - 7} x2={t.x + t.w - 8} y2={y + t.rowH - 7} stroke="#1a1c21" strokeWidth={0.6} />}
          </g>
        );
      })}
    </svg>
  );
}

/** A workbook tick box ("☐ Yes"), drawn, not a font glyph. */
export function TickBox({ on = false }: { on?: boolean }) {
  return (
    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center border border-foreground-700 align-[-2px] text-[10px] leading-none text-foreground-900" aria-hidden="true">{on ? "✓" : ""}</span>
  );
}

const cellView = (c: LayoutCell, placeholder?: string): ReactNode => {
  if (typeof c !== "string") {
    return <span className="flex flex-wrap items-center gap-x-4 gap-y-1">{c.ticks.map(([label, on], i) => <span key={`${label}-${i}`} className="inline-flex items-center gap-1.5"><TickBox on={on} />{label ? <span>{label}</span> : <span className="sr-only">{on ? "Applied" : "Not applied"}</span>}</span>)}</span>;
  }
  return c ? <span className="whitespace-pre-wrap break-words">{c}</span> : placeholder ? <span className="italic text-foreground-400">{placeholder}</span> : <span className="block h-4" />;
};

/** The workbook's label / value table (label column shaded). */
export function WorkbookTable({ rows, head, testId, placeholder, compact = false }: {
  rows: [string, LayoutCell][];
  /** A header row (e.g. "Reasonable adjustment strategy | Applied"); then the rows are plain, not labelled. */
  head?: [string, string];
  testId?: string;
  /** Shown in an empty value cell (the review: "Filled in for each student"). */
  placeholder?: string;
  compact?: boolean;
}) {
  const pad = compact ? "px-2 py-1" : "px-2 py-1.5";
  return (
    <table className="w-full border-collapse text-[12px] text-foreground-900" data-testid={testId}>
      {head ? <thead><tr><th className={`border border-foreground-400 bg-background-100 ${pad} text-left font-semibold`}>{head[0]}</th><th className={`w-24 border border-foreground-400 bg-background-100 ${pad} text-left font-semibold`}>{head[1]}</th></tr></thead> : null}
      <tbody>{rows.map(([label, value], i) => (
        <tr key={`${label}-${i}`}>
          {head ? <td className={`border border-foreground-400 ${pad}`}>{label}</td> : <th scope="row" className={`w-[30%] border border-foreground-400 bg-background-100 ${pad} text-left align-top font-semibold`}>{label}</th>}
          <td className={`border border-foreground-400 ${pad} align-top`}>{cellView(value, placeholder)}</td>
        </tr>
      ))}</tbody>
    </table>
  );
}

/** Cover sections 1 and 2: the student and trainer details, then the qualification and unit (item 3). */
export function DetailsTables({ details, placeholder, testId }: { details: WorkbookDetails; placeholder?: string; testId?: string }) {
  return (
    <div className="space-y-3" data-testid={testId}>
      <div>
        <h3 className="mb-1.5 text-sm font-bold text-foreground-950">1. Student and trainer details</h3>
        <WorkbookTable rows={detailRows(details)} placeholder={placeholder} testId={testId ? `${testId}-people` : undefined} />
      </div>
      <div>
        <h3 className="mb-1.5 text-sm font-bold text-foreground-950">2. Qualification and unit of competency</h3>
        <WorkbookTable rows={qualificationRows(details.qualification, details.unit)} placeholder={placeholder} testId={testId ? `${testId}-qualification` : undefined} />
      </div>
    </div>
  );
}

/** Appendix A – Reasonable Adjustments as the workbook lays it out (item 7): facts, the strategy matrix, the assessor's sign-off. */
export function AdjustmentSheet({ q, value, note }: { q: Question; value: unknown; note?: ReactNode }) {
  const lay = adjustmentLayout(q, value, (d) => new Date(`${d}T00:00:00`).toLocaleDateString("en-AU", { day: "2-digit", month: "2-digit", year: "numeric" }));
  return (
    <div className="space-y-2" data-testid="adjustment-sheet">
      {note}
      {lay.intro ? <p className="whitespace-pre-wrap text-xs text-foreground-600">{lay.intro}</p> : null}
      <WorkbookTable rows={lay.facts} compact />
      {lay.strategies.length ? <WorkbookTable head={["Reasonable adjustment strategy", "Applied"]} rows={lay.strategies.map(([text, on]) => [text, { ticks: [["", on]] }])} compact /> : null}
      {lay.declaration ? <p className="text-xs text-foreground-600">{lay.declaration}</p> : null}
      <WorkbookTable rows={lay.sign} compact />
    </div>
  );
}
