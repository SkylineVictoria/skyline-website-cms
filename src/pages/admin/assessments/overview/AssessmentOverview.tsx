/**
 * ASM-OVERVIEW (owner, 2026-11-25; design "Assessment details page – compact redesign", pages 1-2): the read-only Overview of an
 * assessment, the default view of /admin/assessments/:id. Summary strip, one card per task (the first open), inside a task: Learner
 * instructions (one row, opens to readable paragraphs), General task steps, Supporting material cards, the Questions / Activities
 * (number · first sentence · chips; parts / table rows open as a grid, a template as a small form preview), "Also required" and
 * "Uploads accepted". Every expandable row is a real button (aria-expanded, Enter / Space, at least 44 px tall). A pencil on hover
 * or keyboard focus opens a side drawer scoped to that block (OverviewDrawers); structure (add / remove / reorder questions or
 * tasks) stays in the Builder ("Edit"). No page numbers, reorder or delete icons, no "required" badge; learner-facing numbers only.
 */
import { useMemo, useState, type ReactNode } from "react";
import { sanitize } from "@/components/assessment/registry";
import { workbookNumbering } from "@/lib/assessment/workbookLayout";
import { overviewOf, type Chip, type OverviewGroup, type OverviewRow, type OverviewTask, type RowDetail } from "@/lib/assessment/overview";
import type { Definition, Material, QuestionKey } from "@/lib/assessment/types";
import BlockDrawer, { type BlockTarget, type BlockSave } from "./OverviewDrawers";

const CHIP: Record<Chip["kind"], string> = {
  upload: "bg-background-100 text-foreground-700", calc: "bg-background-100 text-foreground-700", table: "bg-background-100 text-foreground-700",
  parts: "bg-background-100 text-foreground-700", template: "bg-primary-50 text-primary-800", roleplay: "bg-amber-50 text-amber-900",
  deliverable: "bg-sky-50 text-sky-900", optional: "bg-background-100 text-foreground-600", assessor: "bg-background-200 text-foreground-700", conditional: "bg-background-100 text-foreground-600",
};
const MATERIAL_ICON: Record<Material["kind"], string> = { case_study: "ri-briefcase-4-line", drawing: "ri-ruler-2-line", role_play: "ri-discuss-line", document: "ri-file-text-line" };
const MATERIAL_KIND: Record<Material["kind"], string> = { case_study: "Case study", drawing: "Drawing", role_play: "Role-play brief", document: "Document" };
const pagesLabel = (pages: number[]) => (!pages.length ? "" : pages.length === 1 ? `p. ${pages[0]}` : `pp. ${Math.min(...pages)}–${Math.max(...pages)}`);

function Chips({ chips }: { chips: Chip[] }) {
  if (!chips.length) return null;
  return <span className="flex flex-wrap justify-end gap-1">{chips.map((c) => <span key={c.kind + c.label} className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium ${CHIP[c.kind]}`} data-chip={c.kind}>{c.label}</span>)}</span>;
}

/** The pencil of a block: shown on hover or keyboard focus (and always on touch screens), opens the block's drawer. */
function Pencil({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} data-testid="block-edit"
      className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 opacity-0 transition-opacity hover:bg-background-100 hover:text-primary-700 focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100">
      <i className="ri-pencil-line text-base" aria-hidden="true" />
    </button>
  );
}

function Detail({ detail, id }: { detail: RowDetail; id: string }) {
  if (detail.kind === "grid") return (
    <ol id={id} className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 pb-3 pl-14 text-sm text-foreground-800 sm:grid-cols-2 lg:grid-cols-4" data-testid="row-grid">
      {detail.items.map((it, i) => <li key={i} className="flex gap-2"><span className="w-3 shrink-0 text-foreground-500">{it.marker}</span><span>{it.text}</span></li>)}
    </ol>
  );
  return (
    <div id={id} className="px-4 pb-3 pl-14" data-testid="row-template">
      <div className="rounded-lg border border-background-200 bg-background-50 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">{detail.title}</p>
        <ul className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {detail.items.map((it) => it.kind === "section"
            ? <li key={it.id} className="pt-1 text-xs font-semibold text-foreground-800 sm:col-span-2" data-template-item="section">{it.text}</li>
            : <li key={it.id} data-template-item="field"><span className="block text-xs text-foreground-600">{it.text}</span><span className="mt-0.5 block h-6 rounded border border-background-200 bg-white" aria-hidden="true" /></li>)}
        </ul>
      </div>
    </div>
  );
}

function ItemRow({ row, open, onToggle, onEdit, readOnly }: { row: OverviewRow; open: boolean; onToggle: () => void; onEdit: () => void; readOnly: boolean }) {
  const expandable = Boolean(row.detail);
  const detailId = `detail-${row.id}`;
  const body = (
    <>
      <span className={`w-12 shrink-0 pt-px text-sm font-semibold ${row.reading ? "text-foreground-400" : "text-foreground-900"}`}>{row.reading ? <i className={row.heading ? "ri-text" : "ri-information-line"} aria-hidden="true" /> : row.number}</span>
      <span className={`min-w-0 flex-1 text-sm ${row.heading ? "font-semibold text-foreground-800" : row.reading ? "text-foreground-600" : "text-foreground-900"}`}>{row.text}</span>
      <Chips chips={row.chips} />
      {expandable ? <i className={`ri-arrow-${open ? "down" : "right"}-s-line shrink-0 text-lg text-foreground-500`} aria-hidden="true" /> : null}
    </>
  );
  return (
    <li className="group border-t border-background-100" data-row={row.id} data-testid="overview-row">
      <div className="flex items-center pr-2">
        {expandable
          ? <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={detailId} title={row.full} className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-background-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400 sm:flex-nowrap">{body}</button>
          : <div title={row.full} className="flex min-h-[44px] min-w-0 flex-1 flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 sm:flex-nowrap">{body}</div>}
        {!readOnly && !row.reading ? <Pencil label={`Edit ${row.number ?? "item"}`} onClick={onEdit} /> : null}
      </div>
      {expandable && open && row.detail ? <Detail detail={row.detail} id={detailId} /> : null}
    </li>
  );
}

/** A row that opens a block of the task (learner instructions, general steps). */
function BlockRow({ id, icon, title, summary, open, onToggle, onEdit, readOnly, children }: { id: string; icon: string; title: string; summary: string; open: boolean; onToggle: () => void; onEdit: () => void; readOnly: boolean; children: ReactNode }) {
  return (
    <div className="group border-t border-background-100 bg-background-50/60" data-block={id}>
      <div className="flex items-center pr-2">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`block-${id}`} className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left hover:bg-background-100/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400 sm:pl-10">
          <i className={`${icon} text-base text-foreground-600`} aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground-900">{title}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-foreground-600">{summary}</span>
          <i className={`ri-arrow-${open ? "down" : "right"}-s-line text-lg text-foreground-500`} aria-hidden="true" />
        </button>
        {!readOnly ? <Pencil label={`Edit ${title.toLowerCase()}`} onClick={onEdit} /> : null}
      </div>
      {open ? <div id={`block-${id}`} className="px-4 pb-4 sm:pl-10">{children}</div> : null}
    </div>
  );
}

function TaskCard({ t, open, onToggle, isOpen, toggle, edit, readOnly, compact }: {
  t: OverviewTask; open: boolean; onToggle: () => void; isOpen: (k: string) => boolean; toggle: (k: string) => void; edit: (b: BlockTarget) => void; readOnly: boolean; compact: boolean;
}) {
  const materialOpen = t.materials.find((m) => isOpen(`m-${m.id}`));
  // occasion groups: the first open, the others collapsed; the toggle flips the default
  const groups = new Map(t.rows.flatMap((r) => (r.kind === "label" && r.group ? [[r.group.id, r.group] as const] : [])));
  const groupOpen = (g: OverviewGroup) => (g.collapsed ? isOpen(`g-${g.id}`) : !isOpen(`g-${g.id}`));
  return (
    <section className="overflow-hidden rounded-2xl border border-background-200 bg-white" data-testid="task-card" data-task={t.index + 1} aria-label={`Task ${t.index + 1}`}>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={`task-body-${t.id}`} data-testid="task-toggle"
        className="flex min-h-[52px] w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-background-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400">
        <i className={`ri-arrow-${open ? "down" : "right"}-s-line text-lg text-foreground-500`} aria-hidden="true" />
        <span className="rounded-md bg-primary-50 px-2 py-0.5 text-xs font-semibold text-primary-800">Task {t.index + 1}</span>
        <span className="min-w-0 flex-1 font-heading text-base font-semibold text-foreground-950">{t.title}</span>
        <span className="text-sm text-foreground-600" data-testid="task-count">{t.count}</span>
        {!open && t.attached ? <span className="basis-full pl-8 text-sm text-foreground-500" data-testid="task-attached">{t.attached}</span> : null}
      </button>
      {open ? (
        <div id={`task-body-${t.id}`}>
          {t.instructions ? (
            <BlockRow id={`ins-${t.id}`} icon="ri-information-line" title="Learner instructions" summary={t.instructions.summary} open={isOpen(`ins-${t.id}`)} onToggle={() => toggle(`ins-${t.id}`)}
              onEdit={() => edit({ kind: "instructions", taskId: t.id })} readOnly={readOnly}>
              <div className="asm-content max-w-3xl space-y-2 text-sm leading-relaxed text-foreground-800" data-testid="instructions-text" dangerouslySetInnerHTML={{ __html: sanitize(t.instructions.html) }} />
            </BlockRow>
          ) : !readOnly && compact ? (
            <div className="border-t border-background-100 px-4 py-2 sm:pl-10"><button type="button" className="min-h-[44px] cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => edit({ kind: "instructions", taskId: t.id })}>+ Add learner instructions</button></div>
          ) : null}
          {t.steps?.length ? (
            <BlockRow id={`steps-${t.id}`} icon="ri-list-ordered" title={`General task steps · ${t.steps.length}`} summary="" open={isOpen(`steps-${t.id}`)} onToggle={() => toggle(`steps-${t.id}`)}
              onEdit={() => edit({ kind: "steps", taskId: t.id })} readOnly={readOnly}>
              <ol className="max-w-3xl list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-foreground-800" data-testid="steps-list">{t.steps.map((s, i) => <li key={i}>{s.text.replace(/^\d+\.\s*/, "")}</li>)}</ol>
            </BlockRow>
          ) : null}
          {t.materials.length ? (
            <div className="border-t border-background-100 px-4 py-3 sm:pl-10">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">Supporting material</p>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {t.materials.map((m) => (
                  <li key={m.id} className="group relative flex items-stretch rounded-xl border border-background-200 bg-white" data-testid="material-card" data-kind={m.kind}>
                    <button type="button" onClick={() => toggle(`m-${m.id}`)} aria-expanded={isOpen(`m-${m.id}`)} aria-controls={`material-${m.id}`}
                      className="flex min-h-[44px] min-w-0 flex-1 cursor-pointer items-start gap-2.5 rounded-xl px-3 py-2.5 text-left hover:bg-background-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400">
                      <i className={`${MATERIAL_ICON[m.kind]} mt-0.5 text-lg text-primary-600`} aria-hidden="true" />
                      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold text-foreground-900" title={m.title}>{m.title}</span><span className="block text-xs text-foreground-500">{MATERIAL_KIND[m.kind]}{m.pages.length ? ` · ${pagesLabel(m.pages)}` : ""}</span></span>
                    </button>
                    {!readOnly ? <Pencil label={`Edit ${m.title}`} onClick={() => edit({ kind: "material", taskId: t.id, materialId: m.id })} /> : null}
                  </li>
                ))}
              </ul>
              {materialOpen ? (
                <div id={`material-${materialOpen.id}`} className="asm-content mt-3 max-w-3xl space-y-2 rounded-xl border border-background-200 bg-background-50 p-3 text-sm leading-relaxed text-foreground-800 [&_img]:max-h-96 [&_img]:max-w-full" data-testid="material-body"
                  dangerouslySetInnerHTML={{ __html: sanitize(materialOpen.html) }} />
              ) : null}
            </div>
          ) : null}
          {t.rows.length ? (
            <div className="border-t border-background-100">
              {!(t.rows[0].kind === "label" && t.rows[0].group) ? <p className="px-4 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-foreground-500">{t.itemsLabel}</p> : null}
              <ul data-testid="overview-rows">
                {t.rows.map((r) => {
                  if (r.kind === "label" && r.group) {
                    const g = r.group; const gOpen = groupOpen(g);
                    return (
                      <li key={r.id} className="border-t border-background-100 bg-background-50/60" data-testid="occasion-group" data-occasion={g.occasion}>
                        <button type="button" onClick={() => toggle(`g-${g.id}`)} aria-expanded={gOpen} data-testid="occasion-toggle"
                          className="flex min-h-[44px] w-full cursor-pointer flex-wrap items-center gap-x-2 px-4 py-2 text-left hover:bg-background-100/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-400">
                          <i className={`ri-arrow-${gOpen ? "down" : "right"}-s-line text-lg text-foreground-500`} aria-hidden="true" />
                          <span className="text-xs font-semibold uppercase tracking-wide text-foreground-700" data-testid="rows-label">{r.text}</span>
                          {g.note ? <span className="text-sm text-foreground-600" data-testid="occasion-note">{g.note}</span> : null}
                        </button>
                        {gOpen && g.differences.length ? (
                          <ul className="space-y-0.5 px-4 pb-2 pl-11 text-sm text-foreground-600" data-testid="occasion-differences">{g.differences.map((d) => <li key={d} className="list-disc">{d}</li>)}</ul>
                        ) : null}
                      </li>
                    );
                  }
                  const gid = r.kind === "label" ? r.groupId : r.group;
                  const owner = gid ? groups.get(gid) : undefined;
                  if (owner && !groupOpen(owner)) return null;
                  if (r.kind === "label") return <li key={r.id} className={`border-t border-background-100 px-4 py-1.5 text-xs font-semibold text-foreground-600 ${r.sub ? "sm:pl-10" : "bg-background-50/60"}`} data-testid="rows-label">{r.text}</li>;
                  return <ItemRow key={r.id} row={r} open={isOpen(r.id)} onToggle={() => toggle(r.id)} readOnly={readOnly}
                      onEdit={() => edit(r.question.role === "activity" && (r.question.children ?? []).length > 1 || r.question.role === "template" ? { kind: "template", taskId: t.id, questionId: r.id } : { kind: "question", taskId: t.id, questionId: r.id })} />;
                })}
              </ul>
            </div>
          ) : null}
          {t.alsoRequired.length || t.uploadsAccepted.length ? (
            <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-background-100 bg-background-50/60 px-4 py-2.5 text-sm">
              {t.alsoRequired.length ? <p data-testid="also-required"><span className="font-semibold text-foreground-800">Also required</span>{t.alsoRequired.map((r) => <span key={r.id} className="ml-3 text-foreground-600">{r.text}</span>)}</p> : null}
              {t.uploadsAccepted.length ? <p data-testid="uploads-accepted"><span className="font-semibold text-foreground-800">Uploads accepted:</span> <span className="text-foreground-600">{t.uploadsAccepted.join(" · ")}</span></p> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export interface OverviewProps {
  definition: Definition;
  keys: QuestionKey[];
  readOnly: boolean;
  /** The Check cell: issues to fix (links to the Builder's "Needs a look"). */
  issues: { total: number; blocking: number };
  onShowIssues: () => void;
  onSave: BlockSave;
}

export default function AssessmentOverview({ definition, keys, readOnly, issues, onShowIssues, onSave }: OverviewProps) {
  const numbers = useMemo(() => workbookNumbering(definition), [definition]);
  const model = useMemo(() => overviewOf(definition, numbers), [definition, numbers]);
  // open / closed state lives here: a save (or a reload after a published version became a draft) keeps it, and the scroll
  const [openTasks, setOpenTasks] = useState<Set<string>>(() => new Set(definition.tasks[0] ? [definition.tasks[0].id] : []));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<BlockTarget | null>(null);
  const flip = (set: Set<string>, k: string) => { const n = new Set(set); if (n.has(k)) n.delete(k); else n.add(k); return n; };
  const c = model.counts;
  const cells: { label: string; value: ReactNode; testid: string }[] = [
    { label: "Tasks", value: c.tasks, testid: "count-tasks" }, { label: "Questions", value: c.questions, testid: "count-questions" },
    { label: "Activities", value: c.activities, testid: "count-activities" }, { label: "Uploads", value: c.uploads, testid: "count-uploads" },
  ];
  return (
    <div className="space-y-3" data-testid="assessment-overview">
      <dl className="grid grid-cols-2 overflow-hidden rounded-2xl border border-background-200 bg-white sm:grid-cols-5" data-testid="summary-strip">
        {cells.map((x, i) => (
          <div key={x.label} className={`border-background-200 px-4 py-3 ${i % 2 === 1 ? "border-l" : ""} ${i >= 2 ? "border-t sm:border-t-0" : ""} sm:border-l sm:first:border-l-0`}>
            <dt className="text-xs text-foreground-600">{x.label}</dt><dd className="font-heading text-2xl font-semibold text-foreground-950" data-testid={x.testid}>{x.value}</dd>
          </div>
        ))}
        <div className="col-span-2 border-t border-background-200 px-4 py-3 sm:col-span-1 sm:border-l sm:border-t-0">
          <dt className="text-xs text-foreground-600">Check</dt>
          <dd className="mt-1 text-sm font-semibold" data-testid="check-cell">
            {issues.total ? <button type="button" className="min-h-[32px] cursor-pointer text-primary-700 underline-offset-2 hover:underline" onClick={onShowIssues}><i className="ri-error-warning-line mr-1" aria-hidden="true" />{issues.total} issue{issues.total === 1 ? "" : "s"} to fix</button>
              : <span className="text-green-700"><i className="ri-check-line mr-1" aria-hidden="true" />Ready to publish</span>}
          </dd>
        </div>
      </dl>
      {model.reimportHint ? (
        <p className="flex items-start gap-2 rounded-xl border border-background-200 bg-white px-4 py-2.5 text-sm text-foreground-700" data-testid="reimport-hint">
          <i className="ri-refresh-line mt-0.5 text-foreground-500" aria-hidden="true" /><span>This assessment was imported before activities, templates and supporting material were recognised. <strong>Re-import to get the compact view.</strong></span>
        </p>
      ) : null}
      {model.tasks.map((t) => (
        <TaskCard key={t.id} t={t} compact={model.compact} readOnly={readOnly} open={openTasks.has(t.id)} onToggle={() => setOpenTasks((s) => flip(s, t.id))}
          isOpen={(k) => open.has(k)} toggle={(k) => setOpen((s) => flip(s, k))} edit={setTarget} />
      ))}
      {!model.tasks.length ? <p className="rounded-2xl border border-dashed border-background-300 bg-white px-4 py-6 text-center text-sm text-foreground-600">No tasks yet. Use Edit to build the assessment.</p> : null}
      {target ? <BlockDrawer target={target} definition={definition} keys={keys} numbers={numbers} onClose={() => setTarget(null)} onSave={onSave} /> : null}
    </div>
  );
}
