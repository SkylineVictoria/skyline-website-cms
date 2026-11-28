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
//   entity "students": aXcelerate contacts as students (AXCELERATE-STUDENTS): one contact (scope "one"), or every contact enrolled in a
//                      course (scope "all", from /course/enrolments per course; with `since`, only enrolments changed since then)
// The run's cursor is saved after every step, so a long import continues on the next call ("continue") and can be cancelled.

export type ImportEntity = 'trainers' | 'classes' | 'breaks' | 'students';
export const IMPORT_ENTITIES: readonly ImportEntity[] = ['trainers', 'classes', 'breaks', 'students'];
export type Stage = 'locations' | 'courses' | 'classes' | 'breaks' | 'student_list' | 'students' | 'done';
/** One student's outcome, kept on the run so the page can show it ("Student imported", "Needs review: possible duplicate" ...). */
export type StudentResult = { contactId: string; action: string; name?: string; id?: string | null; warnings?: string[]; message?: string };
export type Counts = Record<string, Record<string, number>>;
export type Cursor = {
  stage?: Stage;
  courses?: { ax: string; sk: string; code: string }[];
  courseIndex?: number;
  classCourses?: string[];
  locations?: Record<string, string>;
  trainers?: Record<string, string>;
  notes?: string[];
  /** Students: "one" (contactId) or "all" (every enrolled contact; `since` = only enrolments changed since then, ISO time). */
  scope?: 'one' | 'all';
  contactId?: string;
  since?: string | null;
  studentCourses?: string[];
  studentCourseIndex?: number;
  contacts?: string[];
  contactIndex?: number;
  results?: StudentResult[];
  /** One line per record the run touched: what came in, and what did not and why (shown in the dialog and the Import centre). */
  log?: LogEntry[];
  /** What aXcelerate returned, for the summary notes. */
  seen?: { courses?: number; classes?: number; classesWithTrainer?: number; trainers?: number };
};
export type LogEntry = { entity: string; label: string; ax?: string; action: string; message?: string };
/** At most this many log lines are kept per run (the counts stay complete). */
// rule-policy: technical axcelerate-import-log 2026-11-28 owner (AXCELERATE-IMPORT-LOG): import result wording and log size; no configurable value.
export const LOG_LIMIT = 1000;
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
  if (want.has('students')) stages.push('student_list', 'students');
  return stages;
}

function note(deps: ImportDeps, e: LogEntry) {
  const log = deps.cursor.log ??= [];
  if (log.length < LOG_LIMIT) log.push(e);
}

async function call(deps: ImportDeps, entity: string, ax: string, label: string, name: string, args: Record<string, unknown>, raw: Row): Promise<string | null> {
  const r = await deps.rpc(name, args);
  if (r.error) {
    bump(deps.counts, entity, 'error');
    note(deps, { entity, label: label || ax, ax, action: 'error', message: r.error.message ?? 'Import failed' });
    await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: r.error.message ?? 'Import failed', p_raw: raw });
    return null;
  }
  const out = (r.data ?? {}) as { action?: string; id?: string | null };
  bump(deps.counts, entity, out.action ?? 'done');
  note(deps, { entity, label: label || ax, ax, action: out.action ?? 'done' });
  return out.id ?? null;
}

async function fail(deps: ImportDeps, entity: string, ax: string, label: string, message: string, raw: Row = {}) {
  bump(deps.counts, entity, 'error');
  note(deps, { entity, label: label || ax, ax, action: 'error', message });
  await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: message, p_raw: raw });
}

/** aXcelerate's "YYYY-MM-DD hh:mm" for lastUpdated_min / _max. */
const axTime = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
/** [min, max] windows of at most 89 days from `since` to now (aXcelerate allows 90 days per request). */
export function updatedWindows(since: string, now: number): [string, string][] {
  const day = 86_400_000;
  // One day of overlap: an enrolment read twice is simply "Already up to date".
  let from = Date.parse(since) - day;
  if (!Number.isFinite(from)) return [];
  const out: [string, string][] = [];
  while (from < now) { const to = Math.min(now, from + 89 * day); out.push([axTime(from), axTime(to)]); from = to; }
  return out;
}

/** Plain-language notes on what aXcelerate returned, so a run that brought nothing says why. */
export function summaryNotes(c: Cursor, want: Set<ImportEntity>): string[] {
  const s = c.seen ?? {};
  const courses = s.courses ?? (c.courses ?? []).length, classes = s.classes ?? 0, named = s.classesWithTrainer ?? 0, trainers = s.trainers ?? 0;
  const out = [`aXcelerate returned ${courses} qualification${courses === 1 ? '' : 's'} (courses) and ${classes} class${classes === 1 ? '' : 'es'}; ${named} class${named === 1 ? ' names' : 'es name'} a trainer (${trainers} different trainer${trainers === 1 ? '' : 's'}).`];
  if (!courses) out.push('No qualifications came back from aXcelerate, so there were no classes or trainers to read. Check that the connection is Live (not Staging) and that the aXcelerate API user can see the courses.');
  else if (!classes) out.push('The qualifications have no classes in aXcelerate, so there were no trainers or classes to read.');
  else if (want.has('trainers') && !named) out.push('None of the classes names a trainer in aXcelerate. Trainers are read from the classes (aXcelerate has no trainer list Skyline may read), so no trainer was imported.');
  return out;
}

/** Runs (or continues) an import until it is done, cancelled, or the time budget is used. */
export async function runImport(deps: ImportDeps): Promise<ImportResult> {
  const now = deps.now ?? (() => Date.now());
  const c: Cursor = { locations: {}, trainers: {}, classCourses: [], notes: [], log: [], seen: {}, ...deps.cursor };
  c.log ??= []; c.seen ??= {}; c.notes ??= [];
  deps = { ...deps, cursor: c };
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
      c.seen!.courses = rows.length;
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
        c.seen!.classes = (c.seen!.classes ?? 0) + instances.length;
        for (const inst of instances) {
          const instId = text(inst, 'INSTANCEID', 'ID');
          const label = text(inst, 'NAME') || `class ${instId}`;
          const detailAnswer = instId ? await deps.client.get('/course/instance/detail', { instanceID: instId, type: 'p' }) : null;
          const detail = { ...inst, ...(detailAnswer && detailAnswer.status < 300 ? one(detailAnswer.data) ?? {} : {}) } as Row;
          // Trainer: created (or linked by email) when the class names one.
          const trainerAx = text(detail, 'TRAINERCONTACTID');
          if (trainerAx) c.seen!.classesWithTrainer = (c.seen!.classesWithTrainer ?? 0) + 1;
          let trainer: string | null = trainerAx ? c.trainers![trainerAx] ?? null : null;
          if (trainerAx && !trainer && (want.has('trainers') || want.has('classes'))) {
            const t = await deps.client.get(`/trainer/${trainerAx}`, {});
            const ct = await deps.client.get(`/contact/${trainerAx}`, {});
            const rec = { ...(ct.status < 300 ? one(ct.data) ?? {} : {}), ...(t.status < 300 ? one(t.data) ?? {} : {}), CONTACTID: trainerAx } as Row;
            c.seen!.trainers = (c.seen!.trainers ?? 0) + 1;
            if (!text(rec, 'GIVENNAME', 'NAME', 'EMAILADDRESS', 'EMAIL')) await fail(deps, 'trainer', trainerAx, `trainer ${trainerAx}`, `aXcelerate returned no details for trainer ${trainerAx}.`, rec);
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
      c.notes!.push(...summaryNotes(c, want));
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'student_list') {
      if (c.scope === 'one') {
        c.contacts = c.contactId ? [c.contactId] : [];
      } else {
        // The courses to read enrolments from: the ones this run already listed, else aXcelerate's course list.
        if (!c.studentCourses) {
          c.studentCourses = (c.courses ?? []).map((x) => x.ax);
          if (!c.studentCourses.length) c.studentCourses = (await deps.client.getAll('/courses', { type: 'p' })).map((r) => text(r, 'ID')).filter(Boolean);
          c.studentCourseIndex = 0; c.contacts = [];
        }
        const windows = c.since ? updatedWindows(c.since, now()) : [];
        const seen = new Set(c.contacts ?? []);
        for (let i = c.studentCourseIndex ?? 0; i < c.studentCourses.length; i++) {
          if (!timeLeft()) { c.studentCourseIndex = i; c.contacts = [...seen]; await checkpoint(); return { done: false, cancelled: false, cursor: c, counts: deps.counts }; }
          const passes: Record<string, unknown>[] = windows.length ? windows.map(([min, max]) => ({ lastUpdated_min: min, lastUpdated_max: max })) : [{}];
          for (const extra of passes) {
            const rows = await deps.client.getAll('/course/enrolments', { ID: c.studentCourses[i], type: 'p', ...extra }, { sizeParam: 'limit' });
            for (const r of rows) { const id = text(r, 'CONTACTID'); if (id) seen.add(id); }
          }
          c.studentCourseIndex = i + 1; c.contacts = [...seen];
          if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
        }
        c.contacts = [...seen];
        if (!c.contacts.length) c.notes!.push(c.since ? 'No student enrolments changed in aXcelerate since the last import.' : 'aXcelerate returned no enrolled students.');
      }
      c.contactIndex = 0;
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'students') {
      const contacts = c.contacts ?? [];
      c.results ??= [];
      for (let i = c.contactIndex ?? 0; i < contacts.length; i++) {
        if (!timeLeft()) { c.contactIndex = i; await checkpoint(); return { done: false, cancelled: false, cursor: c, counts: deps.counts }; }
        const id = contacts[i];
        const a = await deps.client.get(`/contact/${id}`, {});
        const rec = a.status < 300 ? one(a.data) : null;
        let result: StudentResult;
        if (!rec) {
          const message = a.status === 404 ? `aXcelerate has no contact ${id}.` : `aXcelerate answered HTTP ${a.status} for contact ${id}.`;
          await fail(deps, 'student', id, '', message);
          result = { contactId: id, action: 'error', message };
        } else {
          const raw = { ...rec, CONTACTID: text(rec, 'CONTACTID') || id };
          const r = await deps.rpc('axcelerate_import_student', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: raw, p_target: null, p_create: false });
          const name = `${text(raw, 'GIVENNAME')} ${text(raw, 'SURNAME')}`.trim();
          if (r.error) {
            bump(deps.counts, 'student', 'error');
            await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: 'student', p_ax: id, p_label: name || null, p_message: r.error.message ?? 'Import failed', p_raw: raw });
            result = { contactId: id, action: 'error', name, message: r.error.message ?? 'Import failed' };
          } else {
            const out = (r.data ?? {}) as { action?: string; id?: string | null; name?: string; warnings?: string[] };
            bump(deps.counts, 'student', out.action ?? 'done');
            result = { contactId: id, action: out.action ?? 'done', name: out.name ?? name, id: out.id ?? null, warnings: out.warnings ?? [] };
          }
        }
        // Keep each student's outcome for "one"; for "all", only the ones that need attention (the counts carry the rest).
        if (c.scope === 'one' || !['created', 'updated', 'unchanged'].includes(result.action) || (result.warnings?.length ?? 0) > 0) {
          if (c.results.length < 500) c.results.push(result);
        }
        c.contactIndex = i + 1;
        if ((i + 1) % 10 === 0 && !(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
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
