import { useCallback, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { PortalEmpty, PortalError, PortalLoading } from "../components/PortalUI";

type Difficulty = "easy" | "medium" | "advanced";
type Unit = { id: string; code: string; name: string; enabled: boolean; hasMaterials: boolean };
type Assignment = { id: string; title: string; unitId: string };
type Catalogue = { units: Unit[]; assessments: Assignment[] };
type Feedback = { selected: number; correct: number; explanation: string; evidence: string };
type Question = { id: string; prompt: string; choices: string[]; topic: string; saved: boolean; feedback: Feedback | null };
type Progress = { answered: number; accuracy: number | null; level: string; topics: { topic: string; total: number; accuracy: number }[];
  saved: { id: string; prompt: string }[] };
type Result = { question?: Question; state?: "generate" | "generating" | "no_materials" | "no_questions" | "daily_limit" };
const difficultyChoices: { id: Difficulty; label: string; icon: string }[] = [
  { id: "easy", label: "Easy", icon: "ri-seedling-line" },
  { id: "medium", label: "Medium", icon: "ri-bar-chart-line" },
  { id: "advanced", label: "Hard", icon: "ri-flashlight-line" },
];
const stateMessage: Partial<Record<NonNullable<Result["state"]>, string>> = {
  no_materials: "This unit needs published learning materials before you can practise.",
  no_questions: "The learning material did not support any new questions for this selection. Try another topic or difficulty.",
  daily_limit: "Today’s AI question allowance has been reached. You can still review saved questions.",
  generating: "New questions are already being prepared. Try again in a moment.",
};
const panel = "min-w-0 rounded-2xl border border-primary-100 bg-background-50 p-4 shadow-sm dark:border-background-200";
const control = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 disabled:opacity-60";
const primary = "rounded-lg bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-primary-800 disabled:opacity-50";
const secondary = "rounded-lg border border-primary-200 px-3 py-2 text-sm font-semibold text-primary-800 hover:bg-primary-50 disabled:opacity-50 dark:border-primary-800 dark:text-primary-300 dark:hover:bg-primary-950/40";
const message = (error: unknown) => error instanceof Error ? error.message : "Practice is temporarily unavailable.";
async function practice<T>(action: string, data: object = {}): Promise<T> {
  const result = await supabase.rpc("student_practice", { p_action: action, p_data: data });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
async function requestQuestions(data: object): Promise<Result> {
  const response = await supabase.functions.invoke<Result>("student-practice", { body: data });
  if (!response.error && response.data) return response.data;
  const errorResponse = response.error && "context" in response.error ? response.error.context : null;
  const body = errorResponse instanceof Response ? await errorResponse.json().catch(() => null) : null;
  throw new Error(body?.message ?? "New questions could not be generated. Please try again.");
}

/** `embedded`: shown as the Practice tab of My learning (owner, 2026-11-23: one page for learning and practice). */
export default function StudentPracticePage({ embedded = false }: { embedded?: boolean } = {}) {
  const [params, setParams] = useSearchParams();
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [focus, setFocus] = useState("");
  const [question, setQuestion] = useState<Question | null>(null);
  const [choice, setChoice] = useState<number | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setCatalogueError("");
    try { setCatalogue(await practice<Catalogue>("catalogue")); }
    catch (e) { setCatalogueError(message(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const assignmentId = params.get("assessment") ?? "";
  const assignment = catalogue?.assessments.find(item => item.id === assignmentId);
  const assessmentMode = params.has("assessment");
  const unit = catalogue?.units.find(item => item.id === (assessmentMode ? assignment?.unitId : params.get("unit")))
    ?? (!assessmentMode ? catalogue?.units.find(item => item.hasMaterials && item.enabled) ?? catalogue?.units[0] : undefined);
  const unitId = unit?.id;
  const validScope = Boolean(unitId && (!assessmentMode || assignment));
  const enabled = validScope && unit?.enabled === true;
  const scope = { unitId, assignmentId: assignment?.id };
  const scopeAssignment = assignment?.id;
  const progressView = params.get("view") === "progress";
  const refreshProgress = useCallback(() => practice<Progress>("progress", { unitId, assignmentId: scopeAssignment }), [unitId, scopeAssignment]);
  useEffect(() => {
    let current = true;
    setProgress(null);
    setQuestion(null);
    setChoice(null);
    setFocus("");
    setError("");
    setNotice("");
    if (enabled) void refreshProgress().then(result => { if (current) setProgress(result); })
      .catch(e => { if (current) setError(message(e)); });
    return () => { current = false; };
  }, [enabled, refreshProgress]);

  const resetQuestion = () => { setQuestion(null); setChoice(null); setError(""); setNotice(""); };
  const go = (mode: "unlimited" | "assessment", nextAssignment = "") => {
    resetQuestion();
    const keep = embedded ? { tab: "practice" } : {};
    setParams(mode === "assessment" ? { ...keep, assessment: nextAssignment } : unitId ? { ...keep, unit: unitId } : keep);
  };
  const next = async () => {
    setBusy("next"); setChoice(null); setError(""); setNotice("");
    try {
      const inputs = { ...scope, difficulty, focus };
      let result = await practice<Result>("next", inputs);
      if (result.state === "generate") result = await requestQuestions(inputs);
      if (result.question) setQuestion(result.question);
      else setNotice(result.state ? stateMessage[result.state] ?? "A new question is currently unavailable." : "A new question is currently unavailable.");
    } catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  };
  const answer = async () => {
    if (!question || choice === null) return;
    setBusy("answer"); setError("");
    try {
      setQuestion(await practice<Question>("answer", { ...scope, questionId: question.id, selected: choice }));
      setProgress(await refreshProgress());
    } catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  };
  const bookmark = async () => {
    if (!question) return;
    setBusy("bookmark"); setError("");
    try {
      setQuestion(await practice<Question>("bookmark", { ...scope, questionId: question.id, saved: !question.saved }));
      setProgress(await refreshProgress());
    } catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  };
  const recall = async (id: string) => {
    setBusy("recall"); setChoice(null); setError(""); setNotice("");
    try {
      setQuestion(await practice<Question>("recall", { ...scope, questionId: id }));
      const target = new URLSearchParams(params);
      target.delete("view");
      setParams(target);
    } catch (e) { setError(message(e)); }
    finally { setBusy(""); }
  };

  const feedback = question?.feedback;
  const correct = feedback?.selected === feedback?.correct;
  const selectedDifficulty = difficultyChoices.find(item => item.id === difficulty)?.label;
  const hasMaterials = unit?.hasMaterials === true;

  return <div className="mx-auto w-full max-w-[1450px] space-y-5 pb-10">
    <header className={`flex flex-wrap items-center gap-3 ${embedded ? "justify-end" : "justify-between"}`}>
      {embedded ? null : <h1 className="font-heading text-2xl font-bold text-primary-900 dark:text-primary-300">Practice</h1>}
      <nav aria-label="Learning navigation" className="flex flex-wrap items-center gap-2 text-sm font-semibold">
        {embedded ? null : <Link className={secondary} to={unitId ? `/agency/learning?unit=${encodeURIComponent(unitId)}` : "/agency/learning"}>Learn</Link>}
        <button type="button" className={progressView ? secondary : primary} disabled={!!busy} aria-current={!progressView ? "page" : undefined}
          onClick={() => { const target = new URLSearchParams(params); target.delete("view"); setParams(target); }}>Practice</button>
        <Link className={secondary} to="/agency/assessments">Assessments</Link>
        <button type="button" className={progressView ? primary : secondary} disabled={!!busy} aria-current={progressView ? "page" : undefined}
          onClick={() => { const target = new URLSearchParams(params); target.set("view", "progress"); setParams(target); }}>Progress</button>
      </nav>
    </header>

    {catalogueError && <PortalError message={catalogueError} onRetry={() => void load()} />}
    {!catalogue && !catalogueError && <PortalLoading label="Loading practice…" />}
    {catalogue && catalogue.units.length === 0 && <PortalEmpty icon="ri-focus-2-line" title="No units to practise yet"
      message="Your practice units appear here after enrolment." />}
    {/* // rule-policy: technical practice-dashboard-layout Arranges practice settings, question and progress at different viewport sizes. */}
    {!!catalogue?.units.length && <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(11rem,1fr)_minmax(0,2.35fr)] xl:grid-cols-[minmax(11rem,1fr)_minmax(0,2.35fr)_minmax(11rem,0.95fr)]">
      <aside aria-label="Practice settings" className={panel + " space-y-5"}>
        <div className="flex items-start gap-2">
          <i className="ri-book-open-line rounded-lg bg-primary-100 p-2 text-xl text-primary-700 dark:bg-primary-950 dark:text-primary-300" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-heading font-bold text-foreground-950">{unit?.code ?? "Choose an assessment"}</p>
            {unit && <p className="text-sm text-foreground-700">{unit.name}</p>}
          </div>
        </div>
        <div className="space-y-2">
          <h2 className="font-heading text-sm font-bold">Practice mode</h2>
          <button type="button" aria-pressed={!assessmentMode} className={secondary + " w-full text-left aria-pressed:border-primary-500 aria-pressed:bg-primary-50 dark:aria-pressed:bg-primary-950/40"} disabled={!!busy} onClick={() => go("unlimited")}>
            <i className="ri-infinity-line mr-2" aria-hidden="true" />Unlimited practice
          </button>
          <button type="button" aria-pressed={assessmentMode} className={secondary + " w-full text-left aria-pressed:border-primary-500 aria-pressed:bg-primary-50 dark:aria-pressed:bg-primary-950/40"} disabled={!!busy} onClick={() => go("assessment", catalogue.assessments[0]?.id)}>
            <i className="ri-focus-3-line mr-2" aria-hidden="true" />Assessment practice
          </button>
        </div>
        {assessmentMode
          ? <label className="block space-y-1 text-sm font-semibold">Assessment
              <select className={control} value={assignment?.id ?? ""} disabled={!!busy} onChange={e => go("assessment", e.target.value)}>
                <option value="">Choose an assessment</option>
                {catalogue.assessments.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
          : <label className="block space-y-1 text-sm font-semibold">Unit
              <select className={control} value={unitId ?? ""} disabled={!!busy} onChange={e => { resetQuestion(); const target = new URLSearchParams(params); target.set("unit", e.target.value); setParams(target); }}>
                {catalogue.units.map(item => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
              </select>
            </label>}
        <fieldset disabled={!!busy} className="space-y-2">
          <legend className="font-heading text-sm font-bold">Difficulty</legend>
          <div className="grid grid-cols-3 gap-1">
            {difficultyChoices.map(item => <button key={item.id} type="button" aria-pressed={difficulty === item.id}
              className="rounded-lg border border-background-200 px-1 py-2 text-xs font-semibold aria-pressed:bg-primary-700 aria-pressed:text-white"
              onClick={() => { if (item.id !== difficulty) { resetQuestion(); setDifficulty(item.id); } }}>
              <i className={item.icon + " mb-1 block text-base"} aria-hidden="true" />{item.label}
            </button>)}
          </div>
        </fieldset>
        {!!progress?.topics.length && <label className="block space-y-1 text-sm font-semibold">Focus topic
          <select className={control} value={focus} disabled={!!busy} onChange={e => { resetQuestion(); setFocus(e.target.value); }}>
            <option value="">All topics</option>
            {progress.topics.map(item => <option key={item.topic} value={item.topic}>{item.topic}</option>)}
          </select>
        </label>}
      </aside>

      <main aria-label={progressView ? "Practice progress" : "Practice question"} className={panel + " space-y-5"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-heading text-lg font-bold text-foreground-950">
            {!progressView && <i className={(assessmentMode ? "ri-focus-3-line" : "ri-infinity-line") + " mr-2 text-primary-700 dark:text-primary-300"} aria-hidden="true" />}
            {progressView ? "Your practice progress" : `${assessmentMode ? "Assessment practice" : "Unlimited practice"} · ${selectedDifficulty}`}
          </h2>
        </div>
        {error && <PortalError message={error} />}
        {notice && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-950" role="status">{notice}</p>}
        {progressView ? <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-primary-50 p-4 dark:bg-primary-950/40">
            <div><p className="text-sm text-foreground-700">Accuracy</p><p className="font-heading text-xl font-bold">{progress?.accuracy == null ? "—" : `${progress.accuracy}%`}</p></div>
            <div><p className="text-sm text-foreground-700">Questions practised</p><p className="font-heading text-xl font-bold">{progress?.answered ?? 0}</p></div>
          </div>
          <TopicProgress progress={progress} unitId={unitId} />
          {!!progress?.saved.length && <div className="space-y-2"><h3 className="font-heading font-bold">Saved questions</h3>
            <ul className="space-y-2">{progress.saved.map(item => <li key={item.id}>
              <button type="button" className={secondary + " w-full text-left"} disabled={!!busy} onClick={() => void recall(item.id)}>{item.prompt}</button>
            </li>)}</ul></div>}
        </div> : !question ? <div className="space-y-4 rounded-xl border border-dashed border-primary-200 p-5 dark:border-primary-800">
          {!validScope
            ? <p className="text-sm text-foreground-700">{catalogue.assessments.length ? "Select an assigned assessment to practise its unit topics." : "No assigned assessments are available for practice."}</p>
            : !enabled
              ? <p className="text-sm text-foreground-700">Practice is awaiting activation for this unit.</p>
              : !hasMaterials
                ? <p className="text-sm text-foreground-700">{stateMessage.no_materials}</p>
                : <><p className="text-sm text-foreground-700">{assessmentMode ? "Revise the topics in this assessment’s unit using published learning materials." : "Answer one question at a time and see the explanation after each answer."}</p>
                  <button type="button" className={primary} disabled={!!busy} onClick={() => void next()}>{busy === "next" ? "Preparing questions…" : "Start practice"}</button></>}
        </div> : <>
          <h3 className="font-heading text-xl font-bold text-foreground-950">{question.prompt}</h3>
          <fieldset className="space-y-2" disabled={!!feedback || !!busy}>
            <legend className="sr-only">Choose one answer</legend>
            {question.choices.map((option, index) => {
              const active = (feedback?.selected ?? choice) === index;
              const tint = feedback?.correct === index ? "border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40"
                : feedback?.selected === index ? "border-rose-300 bg-rose-50 dark:bg-rose-950/40"
                : active ? "border-primary-500 bg-primary-50 dark:bg-primary-950/50" : "border-background-300";
              return <label key={option} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${tint}`}>
                <input type="radio" name={question.id} checked={active} onChange={() => setChoice(index)} className="mt-1 accent-primary-700" />
                <span><b>{String.fromCharCode(65 + index)}.</b> {option}</span>
              </label>;
            })}
          </fieldset>
          {feedback && <section aria-live="polite" className={correct ? "space-y-1 rounded-xl bg-emerald-50 p-4 dark:bg-emerald-950/40" : "space-y-1 rounded-xl bg-amber-50 p-4 dark:bg-amber-950/40"}>
            <p className="font-heading font-bold">{correct ? "Correct!" : `Correct answer: ${String.fromCharCode(65 + feedback.correct)}`}</p>
            <p className="text-sm">{feedback.explanation}</p>
            <blockquote className="border-l-2 border-current pl-2 text-xs text-foreground-700">{feedback.evidence}</blockquote>
            {unitId ? <Link className="inline-flex items-center gap-1 pt-1 text-sm font-semibold text-primary-700 underline" to={learnLink(unitId, question.topic)}>
              <i className="ri-book-open-line" aria-hidden="true" />Learn this topic{question.topic ? `: ${question.topic}` : ""}</Link> : null}
          </section>}
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" className={secondary} aria-pressed={question.saved} disabled={!!busy} onClick={() => void bookmark()}>
              <i className={(question.saved ? "ri-bookmark-fill" : "ri-bookmark-line") + " mr-1"} aria-hidden="true" />{question.saved ? "Saved" : "Save"}
            </button>
            {feedback ? <button type="button" className={primary} disabled={!!busy} onClick={() => void next()}>
              {busy === "next" ? "Preparing questions…" : "Next question"} <i className="ri-arrow-right-line ml-1" aria-hidden="true" /></button>
              : <button type="button" className={primary} disabled={choice === null || !!busy} onClick={() => void answer()}>Check answer</button>}
          </div>
        </>}
      </main>

      <aside aria-label="Your capability" className={panel + " space-y-4 lg:col-start-2 xl:col-start-auto"}>
        <h2 className="font-heading font-bold">Your capability</h2>
        <div className="mx-auto grid h-28 w-28 place-items-center rounded-full border-8 border-primary-200 text-center dark:border-primary-800"
          style={{ borderTopColor: progress?.answered ? "oklch(var(--primary-600))" : undefined }}>
          <div><i className="ri-graduation-cap-line block text-xl text-primary-700 dark:text-primary-300" aria-hidden="true" />
            <p className="text-xs font-bold">{progress?.level ?? "Getting started"}</p></div>
        </div>
        <dl className="grid grid-cols-2 gap-2 rounded-lg bg-primary-50 p-3 text-center dark:bg-primary-950/40">
          <div><dt className="text-xs">Accuracy</dt><dd className="text-lg font-bold">{progress?.accuracy == null ? "—" : `${progress.accuracy}%`}</dd></div>
          <div><dt className="text-xs">Practised</dt><dd className="text-lg font-bold">{progress?.answered ?? 0}</dd></div>
        </dl>
        {!progressView && <TopicProgress progress={progress} unitId={unitId} />}
      </aside>
    </div>}
  </div>;
}

/** My learning, opened at this unit's materials with the topic named (owner, 2026-11-23: "learn by clicking Learn on that topic"). */
function learnLink(unitId: string, topic?: string) {
  const query = new URLSearchParams({ unit: unitId });
  if (topic) query.set("topic", topic);
  return `/agency/learning?${query.toString()}`;
}

function TopicProgress({ progress, unitId }: { progress: Progress | null; unitId?: string }) {
  return <section aria-label="Topic progress" className="space-y-2">
    <h3 className="font-heading text-sm font-bold">Topic progress</h3>
    {progress?.topics.length ? <ul className="space-y-3">{progress.topics.map(topic => <li key={topic.topic}>
      <div className="flex items-center justify-between gap-2 text-xs"><span className="min-w-0 flex-1">{topic.topic}</span>
        {unitId ? <Link className="font-semibold text-primary-700 underline" to={learnLink(unitId, topic.topic)}>Learn</Link> : null}
        <strong>{topic.accuracy}%</strong></div>
      <progress className="h-2 w-full accent-primary-700" value={topic.accuracy} max={100} aria-label={topic.topic} />
    </li>)}</ul> : <p className="text-xs text-foreground-600">Answer questions to see your progress by topic.</p>}
  </section>;
}

/** /agency/practice: Practice is a tab of My learning now; old links (with their unit or assessment) keep working. */
export function PracticeRedirect() {
  const { search } = useLocation();
  const query = new URLSearchParams(search);
  query.set("tab", "practice");
  return <Navigate replace to={`/agency/learning?${query.toString()}`} />;
}
