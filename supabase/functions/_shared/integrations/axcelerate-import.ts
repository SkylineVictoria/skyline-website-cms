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

export type ImportEntity = 'locations' | 'courses' | 'trainers' | 'classes' | 'breaks' | 'agents' | 'students';
/** In dependency order: what a record needs is imported before it ("Import everything" runs them all). */
export const IMPORT_ENTITIES: readonly ImportEntity[] = ['locations', 'courses', 'trainers', 'classes', 'breaks', 'agents', 'students'];
export type Stage = 'locations' | 'courses' | 'classes' | 'breaks' | 'agents' | 'student_list' | 'students' | 'done';
/** One student's outcome, kept on the run so the page can show it ("Student imported", "Needs review: possible duplicate" ...). */
export type StudentResult = {
  contactId: string; action: string; name?: string; id?: string | null; warnings?: string[]; message?: string;
  /** The student's agent (AXCELERATE-AGENTS): imported Inactive; moved = the student now belongs to the agent's business. */
  agent?: { name?: string; action: string; student?: string; business?: string; message?: string };
  /** The student's courses in aXcelerate (kept on the import record; Qualifications are imported in the next stage). */
  courses?: { name: string; status: string }[];
  /** The student's Qualifications imported from their aXcelerate course enrolments (AXCELERATE-QUALIFICATIONS). */
  qualifications?: { name: string; action: string; status?: string; message?: string; warnings?: string[]; units?: UnitResult[] }[];
  /** The student's invoices and payments from aXcelerate (AXCELERATE-FEES). */
  fees?: FeesResult;
};
/** A student's aXcelerate invoices as imported (amounts in cents; void invoices left out of the sums). */
export type FeesResult = { invoices: number; totalCents: number; paidCents: number; balanceCents: number; payments: number; action?: string; message?: string; warnings?: string[] };
/** One unit result imported with a Qualification (aXcelerate unit enrolment, TYPE s). */
export type UnitResult = { code: string; outcome?: string; action: string; message?: string };
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
  /** aXcelerate agent contact ID -> Skyline agent (and its business), so an agent is read once per run. */
  agents?: Record<string, { id: string; name?: string; business?: string } | null>;
  /** aXcelerate class (instance) -> Skyline class; aXcelerate course -> Skyline course; locations read once. */
  classes?: Record<string, string>;
  courseMap?: Record<string, string>;
  locationsLoaded?: boolean;
  /** One course (aXcelerate course ID): the courses / classes stages import only it (the course page's "Import one course"). */
  onlyCourse?: string;
  /** One agent (aXcelerate contact ID): the agents stage imports only them (the agents page's "Import one agent"). */
  agentId?: string;
  agentResult?: StudentResult['agent'];
  /** Skyline courses already checked on the CRICOS register this run. */
  cricosChecked?: string[];
  /** Skyline courses whose aXcelerate calendar events (breaks, holidays) were imported this run. */
  breakCourses?: string[];
};
type Row = Record<string, unknown>;
type Answer = { status: number; data: unknown };
export type ImportClient = { get(path: string, params?: Record<string, unknown>): Promise<Answer>; getAll(path: string, params?: Record<string, unknown>, opt?: { pageSize?: number; sizeParam?: 'displayLength' | 'limit'; maxRows?: number }): Promise<Row[]> };
export type ImportRpc = (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;
export type ImportDeps = {
  client: ImportClient; rpc: ImportRpc; connection: string; run: string; actor: string; entities: ImportEntity[];
  cursor: Cursor; counts: Counts; deadline: number; now?: () => number;
  /**
   * The CRICOS course code of a national code on the provider's CRICOS registration (data.gov.au register; read only), null when the
   * course is not registered, or a rejection when the register could not be read. Absent: no lookup.
   */
  cricos?: (nationalCode: string) => Promise<string | null>;
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
  if (want.has('locations') || want.has('classes')) stages.push('locations');
  if (want.has('courses') || want.has('classes') || want.has('trainers') || want.has('breaks')) stages.push('courses');
  if (want.has('classes') || want.has('trainers') || want.has('breaks')) stages.push('classes');
  if (want.has('breaks')) stages.push('breaks');
  if (want.has('agents')) stages.push('agents');
  if (want.has('students')) stages.push('student_list', 'students');
  return stages;
}

async function call(deps: ImportDeps, entity: string, ax: string, label: string, name: string, args: Record<string, unknown>, raw: Row, notes?: string[]): Promise<string | null> {
  const r = await deps.rpc(name, args);
  if (r.error) {
    bump(deps.counts, entity, 'error');
    await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: r.error.message ?? 'Import failed', p_raw: raw });
    return null;
  }
  const out = (r.data ?? {}) as { action?: string; id?: string | null; warnings?: string[] };
  bump(deps.counts, entity, out.action ?? 'done');
  if (notes) for (const w of out.warnings ?? []) if (notes.length < 200) notes.push(`${label}: ${w}`);
  return out.id ?? null;
}

async function fail(deps: ImportDeps, entity: string, ax: string, label: string, message: string, raw: Row = {}) {
  bump(deps.counts, entity, 'error');
  await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: entity, p_ax: ax || null, p_label: label || null, p_message: message, p_raw: raw });
}

/**
 * A course's CRICOS code from the CRICOS register (owner 2026-11-28): set when Skyline has none, so its imported classes are CoE; a course
 * not on the provider's registration is VoE (noted on the run). Once per course per run.
 */
async function courseCricos(deps: ImportDeps, c: Cursor, courseId: string, nationalCode: string) {
  if (!deps.cricos || !courseId || !nationalCode) return;
  c.cricosChecked ??= [];
  if (c.cricosChecked.includes(courseId)) return;
  c.cricosChecked.push(courseId);
  let code: string | null;
  try { code = await deps.cricos(nationalCode); } catch { c.notes!.push(`${nationalCode}: the CRICOS register could not be read; CoE / VoE decided from the CRICOS code already in Skyline.`); return; }
  if (!code) { c.notes!.push(`${nationalCode} is not on the provider's CRICOS registration: its classes are imported as VoE.`); return; }
  const r = await deps.rpc('axcelerate_course_cricos', { p_course: courseId, p_cricos: code, p_actor: deps.actor });
  if (r.error) c.notes!.push(`${nationalCode}: CRICOS code ${code} was not saved: ${r.error.message ?? 'error'}`);
  else if (r.data === 'set') c.notes!.push(`${nationalCode}: CRICOS code ${code} added from the CRICOS register.`);
  else if (r.data === 'kept') c.notes!.push(`${nationalCode}: Skyline has a different CRICOS code than the register (${code}); kept Skyline's.`);
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

/**
 * One aXcelerate class (course instance): its trainer (created or linked by email), its units (created in the course when missing),
 * then the class itself. Used by the classes stage and by a student's Qualification (the class they are enrolled in).
 */
async function importClassInstance(deps: ImportDeps, c: Cursor, course: { ax: string; sk: string }, inst: Row): Promise<string | null> {
  const want = new Set(deps.entities);
  const instId = text(inst, 'INSTANCEID', 'ID');
  const label = text(inst, 'NAME') || `class ${instId}`;
  const detailAnswer = instId ? await deps.client.get('/course/instance/detail', { instanceID: instId, type: 'p' }) : null;
  const detail = { ...inst, ...(detailAnswer && detailAnswer.status < 300 ? one(detailAnswer.data) ?? {} : {}) } as Row;
  // The class's sessions (its daily timetable), kept on the class's import record for the timetable stage. Read only; the attendees
  // (ENROLLEES) are left out: only the session itself (date, times, room, trainer) is kept.
  if (instId) {
    const att = await deps.client.get('/course/instance/attendance', { instanceID: instId, type: 'p' });
    detail.SESSIONS = att.status < 300 ? list(att.data).slice(0, 500).map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k.toUpperCase() !== 'ENROLLEES')))
      : { status: att.status };
  }
  // Trainer: created (or linked by email) when the class names one.
  const trainerAx = text(detail, 'TRAINERCONTACTID');
  let trainer: string | null = trainerAx ? c.trainers![trainerAx] ?? null : null;
  if (trainerAx && !trainer) {
    const t = await deps.client.get(`/trainer/${trainerAx}`, {});
    const ct = await deps.client.get(`/contact/${trainerAx}`, {});
    const rec = { ...(ct.status < 300 ? one(ct.data) ?? {} : {}), ...(t.status < 300 ? one(t.data) ?? {} : {}), CONTACTID: trainerAx } as Row;
    if (!text(rec, 'GIVENNAME', 'NAME', 'EMAILADDRESS', 'EMAIL')) await fail(deps, 'trainer', trainerAx, '', `aXcelerate returned no details for trainer ${trainerAx}.`, rec);
    else trainer = await call(deps, 'trainer', trainerAx, `${text(rec, 'GIVENNAME')} ${text(rec, 'SURNAME')}`.trim() || text(rec, 'NAME'), 'axcelerate_import_trainer', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: rec }, rec);
    if (trainer) c.trainers![trainerAx] = trainer;
  }
  if (!want.has('classes') && !want.has('students')) return null;
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
    { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: detail, p_course: course.sk, p_units: units, p_trainer: trainer, p_location: location }, detail, c.notes);
  // AXCELERATE-FEES: the course's and the class's fee from aXcelerate's costs, where Skyline has none.
  if (classId) {
    const f = await deps.rpc('axcelerate_course_fees', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_course: course.sk, p_intake: classId });
    const done = String(f.data ?? '');
    if (f.error || done.startsWith('fees not set')) c.notes!.push(`${label}: ${f.error?.message ?? done}`);
    else if (done) c.notes!.push(`${label}: ${done.includes('course') ? 'course fee' : ''}${done.includes('course') && done.includes('class') ? ' and ' : ''}${done.includes('class') ? 'class fee' : ''} set from aXcelerate's cost.`);
  }
  return classId;
}

/**
 * A student's invoices (AXCELERATE-FEES): aXcelerate's invoice list for the contact, each merged with its detail (items, payments), into
 * Skyline's Fees module (invoice, items, payments). Read only.
 */
async function importStudentInvoices(deps: ImportDeps, contactId: string, studentId: string): Promise<FeesResult> {
  const out: FeesResult = { invoices: 0, totalCents: 0, paidCents: 0, balanceCents: 0, payments: 0, warnings: [] };
  const a = await deps.client.get('/accounting/invoice', { contactID: contactId, displayLength: 100 });
  if (a.status >= 300) return { ...out, action: 'error', message: `aXcelerate answered HTTP ${a.status} for the student's invoices.` };
  for (const inv of list(a.data)) {
    const id = text(inv, 'INVOICEID', 'ID');
    if (!id || !/^[0-9]{1,12}$/.test(id)) continue;
    const d = await deps.client.get(`/accounting/invoice/${id}`, {});
    const rec = { ...inv, ...(d.status < 300 ? one(d.data) ?? {} : {}), INVOICEID: id } as Row;
    const r = await deps.rpc('axcelerate_import_invoice', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_student: studentId, p_rec: rec });
    if (r.error) { await fail(deps, 'invoice', id, text(rec, 'INVOICENR', 'INVOICENUMBER') || `invoice ${id}`, r.error.message ?? 'Invoice import failed', rec); out.warnings!.push(`Invoice ${id}: ${r.error.message ?? 'not imported'}`); continue; }
    const v = (r.data ?? {}) as { action?: string; totalCents?: number; paidCents?: number; balanceCents?: number; void?: boolean; payments?: number; warnings?: string[] };
    bump(deps.counts, 'invoice', v.action ?? 'done');
    out.invoices++;
    out.payments += v.payments ?? 0;
    if (!v.void) { out.totalCents += v.totalCents ?? 0; out.paidCents += v.paidCents ?? 0; out.balanceCents += v.balanceCents ?? 0; }
    out.warnings!.push(...(v.warnings ?? []));
  }
  return out;
}

/** aXcelerate's delivery locations, imported once per run (a class's campus). */
async function ensureLocations(deps: ImportDeps, c: Cursor) {
  if (c.locationsLoaded) return;
  const rows = await deps.client.getAll('/course/deliveryLocations', {});
  for (const loc of rows) {
    const ax = text(loc, 'ID', 'CONTACTID');
    const id = await call(deps, 'location', ax, text(loc, 'NAME'), 'axcelerate_import_location', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: loc }, loc);
    if (ax && id) c.locations![ax] = id;
  }
  c.locationsLoaded = true;
}

/** aXcelerate's calendar (/course/calendar), read once per call; events with a date and no class become breaks of a course. */
const calendars = new WeakMap<ImportDeps, Promise<{ status: number; events: Row[] }>>();
function calendarEvents(deps: ImportDeps) {
  let p = calendars.get(deps);
  if (!p) {
    p = deps.client.get('/course/calendar', {}).then((a) => ({ status: a.status, events: a.status < 300 ? list(a.data) : [] }))
      .catch(() => ({ status: 0, events: [] as Row[] }));
    calendars.set(deps, p);
  }
  return p;
}

/**
 * aXcelerate's calendar breaks and holidays for one course (owner 2026-11-28: "bring them and match; do not overwrite the master"): each event
 * becomes a term break of the course (added or matched by date; Skyline's own breaks stay), before the course's classes are laid out, so the
 * daily classes skip them. Once per course per run.
 */
async function ensureBreaks(deps: ImportDeps, c: Cursor, courseSk: string) {
  c.breakCourses ??= [];
  if (c.breakCourses.includes(courseSk)) return;
  c.breakCourses.push(courseSk);
  const { status, events } = await calendarEvents(deps);
  if (status === 0 || status >= 300) { if (!c.notes!.some((n) => n.startsWith('aXcelerate calendar'))) c.notes!.push(`aXcelerate calendar: HTTP ${status || 'no answer'}; breaks not imported.`); return; }
  // The fields aXcelerate sends (names only), so the import can be checked against real data.
  if (!c.notes!.some((n) => n.startsWith('aXcelerate calendar'))) c.notes!.push(`aXcelerate calendar: ${events.length} events (fields: ${[...new Set(events.flatMap((e) => Object.keys(e)))].slice(0, 30).join(', ') || 'none'}).`);
  for (const ev of events) {
    if (text(ev, 'INSTANCEID', 'COURSEID')) continue; // a class or course in the calendar, not a break
    const start = text(ev, 'STARTDATE', 'START', 'DATE', 'EVENTDATE');
    if (!start) continue;
    const rec = { id: text(ev, 'ID', 'EVENTID', 'CALENDARID'), label: text(ev, 'NAME', 'TITLE', 'DESCRIPTION', 'EVENTNAME') || 'Break',
      start, end: text(ev, 'FINISHDATE', 'END', 'ENDDATE') || start };
    await call(deps, 'break', `${courseSk}:${rec.id || start}`, rec.label, 'axcelerate_import_break', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_course: courseSk, p_rec: rec }, ev);
  }
}

/**
 * The class a student's aXcelerate enrolment is in, with everything it needs first (campuses, the course, the class's units and trainer).
 * Read once per run per class.
 */
async function ensureClass(deps: ImportDeps, c: Cursor, e: Row): Promise<string> {
  const instId = text(e, 'INSTANCEID');
  if (!instId) throw new Error('aXcelerate gave no class (instance) for this enrolment.');
  c.classes ??= {};
  if (c.classes[instId]) return c.classes[instId];
  // The course comes from the class's own details (an enrolment row's ID is not always the course); else by the course code.
  const d = await deps.client.get('/course/instance/detail', { instanceID: instId, type: 'p' });
  const detail = d.status < 300 ? one(d.data) ?? {} : {};
  let courseAx = text(detail, 'COURSEID', 'ID');
  if (courseAx === instId) courseAx = '';
  const code = text(detail, 'CODE') || text(e, 'CODE');
  if (!courseAx && code) {
    const all = await deps.client.getAll('/courses', { type: 'p' });
    courseAx = text(all.find((r) => text(r, 'CODE').toUpperCase() === code.toUpperCase()), 'ID');
  }
  if (!courseAx) throw new Error(`aXcelerate gave no course for class ${instId}${code ? ` (${code})` : ''}.`);
  c.courseMap ??= {};
  for (const x of c.courses ?? []) c.courseMap[x.ax] ??= x.sk;
  let sk = c.courseMap[courseAx];
  if (!sk) {
    const cd = await deps.client.get('/course/detail', { ID: courseAx, type: 'p' });
    const rec = { CODE: code, NAME: text(detail, 'COURSENAME', 'QUALIFICATION') || text(e, 'NAME'), ...(cd.status < 300 ? one(cd.data) ?? {} : {}), ID: courseAx } as Row;
    const id = await call(deps, 'course', courseAx, `${text(rec, 'CODE')} ${text(rec, 'NAME')}`.trim(), 'axcelerate_import_course', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: rec }, rec);
    if (!id) throw new Error(`The course ${text(rec, 'CODE', 'NAME') || courseAx} could not be imported (see Errors in the Import centre).`);
    sk = id; c.courseMap[courseAx] = id;
  }
  await courseCricos(deps, c, sk, code);
  await ensureLocations(deps, c);
  await ensureBreaks(deps, c, sk);
  const classId = await importClassInstance(deps, c, { ax: courseAx, sk }, { INSTANCEID: instId, NAME: text(detail, 'NAME') || text(e, 'NAME') } as Row);
  if (!classId) throw new Error(`The class ${instId} could not be imported (see Errors in the Import centre).`);
  c.classes[instId] = classId;
  return classId;
}

/** The student's Qualifications: each aXcelerate course enrolment, with its class, as an Enrolled application + Qualification. */
async function importStudentQualifications(deps: ImportDeps, c: Cursor, studentId: string, enrolments: Row[], unitRows: Row[] = []): Promise<NonNullable<StudentResult['qualifications']>> {
  const out: NonNullable<StudentResult['qualifications']> = [];
  for (const e of enrolments) {
    const name = text(e, 'NAME', 'CODE') || 'Course';
    if (!text(e, 'INSTANCEID')) { out.push({ name, action: 'error', message: 'aXcelerate gave no class for this enrolment.' }); continue; }
    try {
      const intake = await ensureClass(deps, c, e);
      const r = await deps.rpc('axcelerate_import_qualification', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_student: studentId, p_rec: e, p_intake: intake });
      if (r.error) throw new Error(r.error.message ?? 'Qualification import failed');
      const q = (r.data ?? {}) as { id?: string; action?: string; status?: string; warnings?: string[] };
      bump(deps.counts, 'qualification', q.action ?? 'done');
      // Its study plan and unit results: the qualification enrolment's own unit activities (TYPE s, all its units with their dates and
      // outcomes), else the contact's unit enrolments of this ENROLID. Each unit's aXcelerate workshop (TYPE w, its delivery) is read and
      // kept with the unit (read only) for the daily timetable.
      const enrolId = text(e, 'ENROLID');
      const own = list(e.ACTIVITIES).filter((u) => text(u, 'TYPE').toLowerCase() === 's');
      const mine = own.length ? own : unitRows.filter((u) => text(u, 'TYPE').toLowerCase() === 's' && (!enrolId || !text(u, 'ENROLID') || text(u, 'ENROLID') === enrolId));
      for (const u of mine) {
        const w = list(u.ACTIVITIES).find((x) => text(x, 'TYPE').toLowerCase() === 'w' && text(x, 'INSTANCEID'));
        if (!w) continue;
        const d = await deps.client.get('/course/instance/detail', { instanceID: text(w, 'INSTANCEID'), type: 'w' });
        u.WORKSHOP = d.status < 300 ? Object.fromEntries(Object.entries(one(d.data) ?? {}).filter(([k]) => !['ENROLLEES', 'ATTENDEES', 'STUDENTS'].includes(k.toUpperCase())))
          : { status: d.status };
      }
      let units: UnitResult[] | undefined;
      if (q.id) {
        const ur = await deps.rpc('axcelerate_import_unit_results', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_enrolment: q.id, p_units: mine });
        if (ur.error) units = [{ code: '', action: 'error', message: ur.error.message ?? 'Unit results were not imported' }];
        else {
          const data = (ur.data ?? {}) as { units?: UnitResult[]; warnings?: string[] };
          units = data.units ?? [];
          q.warnings = [...(q.warnings ?? []), ...(data.warnings ?? [])];
        }
        for (const u of units) bump(deps.counts, 'unit_result', u.action);
      }
      out.push({ name, action: q.action ?? 'done', status: q.status, warnings: q.warnings ?? [], ...(units?.length ? { units } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Qualification import failed';
      bump(deps.counts, 'qualification', 'error');
      await deps.rpc('axcelerate_import_error', { p_run: deps.run, p_entity: 'qualification', p_ax: text(e, 'ENROLID', 'INSTANCEID') || null, p_label: name, p_message: message, p_raw: e });
      out.push({ name, action: 'error', message });
    }
  }
  return out;
}

/**
 * The student's agent (AXCELERATE-AGENTS): reads the agent (/agent/:id, else /contact/:id) and their organisation once per run, imports
 * them (agent Inactive until their agreement is signed; the organisation as the agent's business), then links the student.
 */
async function importAgent(deps: ImportDeps, c: Cursor, ax: string): Promise<{ id: string; name?: string; business?: string; action?: string } | null> {
  c.agents ??= {};
  if (!(ax in c.agents)) {
    const a = await deps.client.get(`/agent/${ax}`, {});
    const ct = await deps.client.get(`/contact/${ax}`, {});
    const agent = { ...(ct.status < 300 ? one(ct.data) ?? {} : {}), ...(a.status < 300 ? one(a.data) ?? {} : {}), CONTACTID: ax } as Row;
    const orgId = text(agent, 'ORGID', 'ORGANISATIONID');
    const org = /^[0-9]{1,12}$/.test(orgId) ? await deps.client.get(`/organisation/${orgId}`, {}) : null;
    const orgRec = org && org.status < 300 ? { ...(one(org.data) ?? {}), ORGID: orgId } : (orgId ? { ORGID: orgId } : {});
    const r = await deps.rpc('axcelerate_import_agent', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_agent: agent, p_org: orgRec });
    if (r.error) {
      await fail(deps, 'agent', ax, text(agent, 'GIVENNAME', 'NAME'), r.error.message ?? 'Agent import failed', agent);
      c.agents[ax] = null;
      return null;
    }
    const out = (r.data ?? {}) as { action?: string; id?: string; name?: string; businessName?: string };
    bump(deps.counts, 'agent', out.action ?? 'done');
    c.agents[ax] = out.id ? { id: out.id, name: out.name, business: out.businessName } : null;
    return c.agents[ax] ? { ...c.agents[ax]!, action: out.action } : null;
  }
  return c.agents[ax] ? { ...c.agents[ax]!, action: 'unchanged' } : null;
}

async function importStudentAgent(deps: ImportDeps, c: Cursor, rec: Row, studentId: string): Promise<StudentResult['agent']> {
  const ax = text(rec, 'AGENTCONTACTID');
  if (!ax || !/^[0-9]{1,12}$/.test(ax)) return undefined;
  const g = await importAgent(deps, c, ax);
  if (!g) return { action: 'error', message: `The agent (aXcelerate contact ${ax}) could not be imported; see the Import centre.` };
  const m = await deps.rpc('axcelerate_student_agent', { p_student: studentId, p_agent: g.id, p_actor: deps.actor });
  return { name: g.name, business: g.business, action: 'imported', student: m.error ? 'error' : String(m.data ?? 'kept'), message: m.error?.message };
}

/** Runs (or continues) an import until it is done, cancelled, or the time budget is used. */
export async function runImport(deps: ImportDeps): Promise<ImportResult> {
  const now = deps.now ?? (() => Date.now());
  const c: Cursor = { locations: {}, trainers: {}, classCourses: [], notes: [], ...deps.cursor };
  const stages = stagesFor(deps.entities);
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
      c.locationsLoaded = true;
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'courses') {
      const rows = (await deps.client.getAll('/courses', { type: 'p' })).filter((r) => !c.onlyCourse || text(r, 'ID') === c.onlyCourse);
      if (c.onlyCourse && !rows.length) c.notes!.push(`aXcelerate has no course ${c.onlyCourse}.`);
      c.courses = [];
      for (const course of rows) {
        const ax = text(course, 'ID');
        const id = await call(deps, 'course', ax, `${text(course, 'CODE')} ${text(course, 'NAME')}`.trim(), 'axcelerate_import_course', { p_connection: deps.connection, p_run: deps.run, p_actor: deps.actor, p_rec: course }, course);
        if (ax && id) { c.courses.push({ ax, sk: id, code: text(course, 'CODE') }); await courseCricos(deps, c, id, text(course, 'CODE')); }
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
          const classId = await importClassInstance(deps, c, course, inst);
          if (classId && !c.classCourses!.includes(course.sk)) c.classCourses!.push(course.sk);
        }
        c.courseIndex = i + 1;
        if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      }
      next(); if (!(await checkpoint())) return { done: false, cancelled: true, cursor: c, counts: deps.counts };
      continue;
    }

    if (c.stage === 'agents') {
      // One agent (the agents page). Every student's agent also comes with the students import.
      if (c.agentId) {
        const g = await importAgent(deps, c, c.agentId);
        c.agentResult = g ? { name: g.name, business: g.business, action: g.action ?? 'imported' } : { action: 'error', message: `The agent (aXcelerate contact ${c.agentId}) could not be imported; see Errors in the Import centre.` };
      }
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
          // The student's enrolments. /contact/enrolments/:id lists unit enrolments (TYPE s, with their outcome) and e-learning (el);
          // the qualification enrolments themselves (TYPE p, with their class) come from /course/enrolments for the contact.
          const en = await deps.client.get(`/contact/enrolments/${id}`, {});
          const enrolments = en.status < 300 ? list(en.data).filter((e) => !['w', 'el'].includes(text(e, 'TYPE').toLowerCase())) : [];
          const programs = await deps.client.getAll('/course/enrolments', { contactID: id, type: 'p' }, { sizeParam: 'limit', maxRows: 200 })
            .then((rows) => rows.filter((e) => text(e, 'INSTANCEID') && String(text(e, 'CONTACTID') || id) === id)).catch(() => [] as Row[]);
          const raw = { ...rec, CONTACTID: text(rec, 'CONTACTID') || id, ENROLMENTS: enrolments, PROGRAMS: programs };
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
            if (programs.length || enrolments.length) result.courses = [
              ...programs.map((e) => ({ name: text(e, 'NAME', 'CODE') || `Course ${text(e, 'INSTANCEID')}`, status: text(e, 'STATUS') || 'enrolled' })),
              ...enrolments.map((e) => ({ name: `Unit ${text(e, 'CODE')} ${text(e, 'NAME')}`.trim(), status: text(e, 'OUTCOMECODE') ? `outcome ${text(e, 'OUTCOMECODE')}` : text(e, 'STATUS') || 'unknown' })),
            ];
            if (out.id && !['duplicate', 'skipped'].includes(result.action)) {
              result.agent = await importStudentAgent(deps, c, raw, out.id);
              // Qualifications: course enrolments (not workshops), each with its class and everything the class needs.
              const quals = programs.length ? programs : enrolments.filter((e) => text(e, 'TYPE').toLowerCase() === 'p');
              if (quals.length) result.qualifications = await importStudentQualifications(deps, c, out.id, quals, enrolments);
              else if (enrolments.some((e) => text(e, 'TYPE').toLowerCase() === 's')) {
                result.warnings = [...(result.warnings ?? []), 'aXcelerate lists unit enrolments for this student but no qualification enrolment (course enrolments, type p): no Qualification was imported.'];
              }
              // Invoices and payments (after the Qualifications, so each invoice finds its Qualification).
              result.fees = await importStudentInvoices(deps, id, out.id);
            }
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
