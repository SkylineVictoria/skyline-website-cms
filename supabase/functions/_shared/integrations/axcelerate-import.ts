// The aXcelerate import engine (AXCELERATE-IMPORT, owner 2026-11-28). One engine for every way of importing: a page's
// "Import from aXcelerate" button (only that page's entity) and the dashboard's "Import everything" (every entity, in order).
// Same code, same database functions, so the results are identical.
//
// Data flows one way: it reads aXcelerate ONLY through axcelerateClient (GET, read-only allow-list) and writes Skyline through the
// axcelerate_import_* database functions (which create missing references, keep admin edits, honour the skipped list and record links).
// Runtime-neutral (no Deno globals): scripts/test-document-provider.ts runs it against a fake aXcelerate and a fake database.
//
// Stages (in this order): locations -> courses -> classes (each class: its units, its trainer, then the class) -> breaks.
//   entity "trainers": the trainers named on aXcelerate's classes (aXcelerate has no trainer list on the read-only list)
//   entity "classes":  the classes, creating their course, units, location and trainer when they do not exist yet
//   entity "breaks":   aXcelerate's calendar events (/course/calendar) as term breaks of the courses that have imported classes
// The run's cursor is saved after every step, so a long import continues on the next call ("continue") and can be cancelled.

export type ImportEntity = 'trainers' | 'classes' | 'breaks';
export const IMPORT_ENTITIES: readonly ImportEntity[] = ['trainers', 'classes', 'breaks'];
export type Stage = 'locations' | 'courses' | 'classes' | 'breaks' | 'done';
export type Counts = Record<string, Record<string, number>>;
export type Cursor = {
  stage?: Stage;
  courses?: { ax: string; sk: string; code: string }[];
  courseIndex?: number;
  classCourses?: string[];
  locations?: Record<string, string>;
  trainers?: Record<string, string>;
  notes?: string[];
};
type Row = Record<string, unknown>;
type Answer = { status: number; data: unknown };
export type ImportClient = { get(path: string, params?: Record<string, unknown>): Promise<Answer>; getAll(path: string, params?: Record<string, unknown>, opt?: { pageSize?: number; sizeParam?: 'displayLength' | 'limit'; maxRows?: number }): Promise<Row[]> };
export type ImportRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
export type ImportDeps = {
  client: ImportClient; rpc: ImportRpc; connection: string; run: string; actor: string; entities: ImportEntity[];
  cursor: Cursor; counts: Counts; deadline: number; now?: () => number;
  /** Saves progress; returns false when the run was cancelled. */
  save: (cursor: Cursor, counts: Counts) => Promise<boolean>;
};
export type ImportResult = { done: boolean; cancelled: boolean; cursor: Cursor; counts: Counts };

const text = (r: Row | undefined, ...keys: string[]) => { for (const k of keys) { const v = r?.[k]; if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim(); } return ''; };
const one = (data: unknown): Row | null => Array.isArray(data) ? (data[0] as Row ?? null) : data && typeof data === 'object' ? data as Row : null;
const list = (data: unknown): Row[] => Array.isArray(data) ? data as Row[] : [];

function bump(counts: Counts, entity: string, action: string) {
  counts[entity] ??= {};
  counts[entity][action] = (counts[entity][action] ?? 0) + 1;
}

/** Which stages a run needs for the entities asked. */
export function stagesFor(entities: ImportEntity[]): Stage[] {
  const want = new Set(entities);
  const stages: Stage[] = [];
  if (want.has('classes')) stages.push('locations');
  if (want.has('classes') || want.has('trainers') || want.has('breaks')) stages.push('courses', 'classes');
  if (want.has('breaks')) stages.push('breaks');
  return stages;
}

async function call(deps: ImportDeps, entity: string, ax: string, label: string, name: string, args: Record<string, unknown>, raw: Row): Promise<string | null> {
  const r = await deps.rpc(name, args);
  if (r.error) {
    bump(deps.counts, entity, 'error');
    await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: r.error.message ?? 'Import failed', p_raw: raw });
    return null;
  }
  const out = (r.data ?? {}) as { action?: string; id?: string | null };
  bump(deps.counts, entity, out.action ?? 'done');
  return out.id ?? null;
}

async function fail(deps: ImportDeps, entity: string, ax: string, label: string, message: string, raw: Row = {}) {
  bump(deps.counts, entity, 'error');
  await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: message, p_raw: raw });
}

/** Runs (or continues) an import until it is done, cancelled, or the time budget is used. */
export async function runImport(deps: ImportDeps): Promise<ImportResult> {
  const now = deps.now ?? (() => Date.now());
  const c: Cursor = { locations: {}, trainers: {}, classCourses: [], notes: [], ...deps.cursor };
  const stages = stagesFor(deps.entities);
  const want = new Set(deps.entities);
  if (!c.stage) c.stage = stages[0] ?? 'done';
  const next = () => { const i = stages.indexOf(c.stage as Stage); c.stage = stages[i + 1] ?? 'done'; c.courseIndex = 0; };
  const checkpoint = async () => (await deps.save(c, deps.counts));
  const timeLeft = () => now() < deps.deadline;

  while (c.stage !== 'done') {
    if (!timeLeft()) return { done: false, cancelled: false, cursor: c, counts: deps.counts };

    if (c.stage === 'locations') {
      const rows = await deps.client.getAll('/course/deliveryLocations', {});
      for (const loc of rows) {
        const ax = text(loc, 'ID', 'CONTACTID');
        const id = await call(deps, 'location', ax, text(loc, 'NAME'), 'axcelerate_import_location', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: loc }, loc);
        if (ax && id) c.locations![ax] = id;
      }
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'courses') {
      const rows = await deps.client.getAll('/courses', { type: 'p' });
      c.courses = [];
      for (const course of rows) {
        const ax = text(course, 'ID');
        const id = await call(deps, 'course', ax, `${text(course, 'CODE')} ${text(course, 'NAME')}`.trim(), 'axcelerate_import_course', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: course }, course);
        if (ax && id) c.courses.push({ ax, sk: id, code: text(course, 'CODE') });
      }
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'classes') {
      const courses = c.courses ?? [];
      for (let i = c.courseIndex ?? 0; i < courses.length; i++) {
        if (!timeLeft()) { c.courseIndex = i; await checkpoint(); return { done: false, cancelled: false, cursor: c, counts: deps.counts }; }
        const course = courses[i];
        const instances = await deps.client.getAll('/course/instances', { ID: course.ax, type: 'p', public: 'false', current: 'false' });
        for (const inst of instances) {
          const instId = text(inst, 'INSTANCEID', 'ID');
          const label = text(inst, 'NAME') || `class ${instId}`;
          const detailAnswer = instId ? await deps.client.get('/course/instance/detail', { instanceID: instId, type: 'p' }) : null;
          const detail = { ...inst, ...(detailAnswer && detailAnswer.status < 300 ? one(detailAnswer.data) ?? {} : {}) } as Row;
          // Trainer: created (or linked by email) when the class names one.
          const trainerAx = text(detail, 'TRAINERCONTACTID');
          let trainer: string | null = trainerAx ? c.trainers![trainerAx] ?? null : null;
          if (trainerAx && !trainer && (want.has('trainers') || want.has('classes'))) {
            const t = await deps.client.get(`/trainer/${trainerAx}`, {});
            const ct = await deps.client.get(`/contact/${trainerAx}`, {});
            const rec = { ...(ct.status < 300 ? one(ct.data) ?? {} : {}), ...(t.status < 300 ? one(t.data) ?? {} : {}), CONTACTID: trainerAx } as Row;
            if (!text(rec, 'GIVENNAME', 'NAME', 'EMAILADDRESS', 'EMAIL')) await fail(deps, 'trainer', trainerAx, '', `aXcelerate returned no details for trainer ${trainerAx}.`, rec);
            else trainer = await call(deps, 'trainer', trainerAx, `${text(rec, 'GIVENNAME')} ${text(rec, 'SURNAME')}`.trim() || text(rec, 'NAME'), 'axcelerate_import_trainer', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: rec }, rec);
            if (trainer) c.trainers![trainerAx] = trainer;
          }
          if (!want.has('classes')) continue;
          // Units of the class (created in the course when missing), then the class itself.
          const units: { unitId: string; start: string; end: string; order: unknown }[] = [];
          for (const u of list(detail.UNITS)) {
            const unitId = await call(deps, 'unit', `${course.sk}:${text(u, 'UNITCODE', 'CODE')}`, text(u, 'UNITCODE', 'CODE'), 'axcelerate_import_unit',
              { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_course: course.sk, p_rec: u }, u);
            if (unitId) units.push({ unitId, start: text(u, 'SCHEDULEDSTARTDATE'), end: text(u, 'SCHEDULEDENDDATE'), order: u.UNITORDER ?? null });
          }
          const locAx = text(detail, 'DELIVERYLOCATIONID');
          const location = locAx ? c.locations![locAx] ?? null : null;
          const classId = await call(deps, 'class', instId, label, 'axcelerate_import_class',
            { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: detail, p_course: course.sk, p_units: units, p_trainer: trainer, p_location: location }, detail);
          if (classId && !c.classCourses!.includes(course.sk)) c.classCourses!.push(course.sk);
        }
        c.courseIndex = i + 1;
        if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      }
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'breaks') {
      const a = await deps.client.get('/course/calendar', {});
      const events = a.status < 300 ? list(a.data) : [];
      if (a.status >= 300) c.notes!.push(`aXcelerate answered HTTP ${a.status} for its calendar; no breaks were imported.`);
      else if (!events.length) c.notes!.push('aXcelerate returned no calendar events; no breaks were imported.');
      // Breaks apply to the courses that have classes from aXcelerate (Skyline keeps term breaks per course).
      let courses = c.classCourses ?? [];
      if (!courses.length) courses = (c.courses ?? []).map((x) => x.sk);
      for (const ev of events) {
        const start = text(ev, 'STARTDATE', 'START', 'DATE', 'EVENTDATE');
        const rec = { id: text(ev, 'ID', 'EVENTID', 'CALENDARID'), label: text(ev, 'NAME', 'TITLE', 'DESCRIPTION', 'EVENTNAME') || 'Break',
          start, end: text(ev, 'FINISHDATE', 'END', 'ENDDATE') || start };
        if (!start) { await fail(deps, 'break', rec.id, rec.label, 'The calendar event has no date.', ev); continue; }
        for (const sk of courses) {
          await call(deps, 'break', `${sk}:${rec.id || start}`, rec.label, 'axcelerate_import_break', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_course: sk, p_rec: rec }, ev);
        }
      }
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }
    next();
  }
  return { done: true, cancelled: false, cursor: c, counts: deps.counts };
}
