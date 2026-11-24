import { useEffect, useRef, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

type Turn = { role: "student" | "tutor"; text: string; keyPoints?: string[]; sources?: string[] };

/**
 * Learn with AI (owner, 2026-11-23): inside a unit on My learning › Learn, the student asks the AI to explain the unit, its key
 * points or a topic, or anything else about it. The student-practice Edge Function (mode "tutor") answers from the unit's learner
 * material only and names the material it used. The last few turns go with each question so follow-ups make sense.
 */
export default function AiTutor({ unitId, unitName, topic }: { unitId: string; unitName: string; topic?: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: "nearest" }); }, [turns]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true); setError(""); setQuestion("");
    const history = turns.slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, 2000) }));
    setTurns((all) => [...all, { role: "student", text: q }]);
    const res = await supabase.functions.invoke<{ answer: string; keyPoints: string[]; sources: string[] }>("student-practice",
      { body: { mode: "tutor", unitId, question: q, history } });
    setBusy(false);
    if (res.error || !res.data?.answer) {
      const context = res.error && "context" in res.error ? (res.error as { context?: Response }).context : null;
      const body = context instanceof Response ? await context.json().catch(() => null) : null;
      setError(body?.message ?? "The AI could not answer right now. Please try again.");
      setTurns((all) => all.slice(0, -1));
      setQuestion(q);
      return;
    }
    setTurns((all) => [...all, { role: "tutor", text: res.data!.answer, keyPoints: res.data!.keyPoints, sources: res.data!.sources }]);
  };

  const quick = [
    "Explain this unit in simple words",
    "What are the key points I need to know?",
    ...(topic ? [`Explain ${topic} with an example`] : ["Give me an everyday example from this unit"]),
  ];
  const chip = "rounded-full border border-primary-200 bg-primary-50 px-3 py-1 text-xs font-semibold text-primary-800 hover:bg-primary-100 disabled:opacity-50";

  return (
    <section className="rounded-lg border border-primary-200 bg-white p-3" aria-label={`Learn ${unitName} with AI`}>
      <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground-950"><i className="ri-sparkling-2-line text-primary-600" aria-hidden="true" />Learn with AI</p>
      <p className="mt-0.5 text-xs text-foreground-600">Ask anything about this unit. Answers come only from this unit's learning materials; check with your trainer if unsure.</p>
      {turns.length ? <div className="mt-3 max-h-96 space-y-2 overflow-y-auto">
        {turns.map((t, i) => <div key={i} className={`rounded-lg px-3 py-2 text-sm ${t.role === "student" ? "ml-auto max-w-[85%] bg-primary-50 text-foreground-900" : "max-w-[95%] border border-background-200 bg-background-50 text-foreground-800"}`}>
          <p className="whitespace-pre-wrap">{t.text}</p>
          {t.keyPoints?.length ? <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-foreground-700">{t.keyPoints.map((k) => <li key={k}>{k}</li>)}</ul> : null}
          {t.sources?.length ? <p className="mt-1.5 text-2xs text-foreground-500">From: {t.sources.join(", ")}</p> : null}
        </div>)}
        {busy ? <p className="text-xs text-foreground-500">Thinking…</p> : null}
        <div ref={endRef} />
      </div> : null}
      <div className="mt-3 flex flex-wrap gap-1.5">{quick.map((q) => <button key={q} type="button" className={chip} disabled={busy} onClick={() => void ask(q)}>{q}</button>)}</div>
      {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
        <label htmlFor={`tutor-${unitId}`} className="sr-only">Your question</label>
        <input id={`tutor-${unitId}`} value={question} maxLength={1000} disabled={busy} onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about this unit…" className="min-w-0 flex-1 rounded-lg border border-background-300 px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40" />
        <button type="submit" disabled={busy || !question.trim()} className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-50">{busy ? "…" : "Ask"}</button>
      </form>
    </section>
  );
}
