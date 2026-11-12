import { useState } from "react";
import type { User } from "@supabase/supabase-js";
import { Button } from "@/pages/admin/components/ui";
import CompleteStudentProfile from "@/pages/login/CompleteStudentProfile";
import CompleteAgentProfile from "@/pages/login/CompleteAgentProfile";
import { readSignUpIntent, rememberSignUpIntent, type SignUpIntent } from "@/lib/authProviders";

/**
 * A Google / Facebook / phone account that is not set up yet: student or agent (remembered from where they started,
 * changeable here), then that form. A student goes straight in; an agent's business waits for review.
 */
const AGENT_SELF_SIGN_UP = false;

export default function CompleteSignUp({ user, onStudentDone, onAgentDone, onCancel }: {
  user: User; onStudentDone: (apply: boolean) => void; onAgentDone: (businessName: string) => void; onCancel: () => void;
}) {
  // Agencies are set up by SLIT for now (the server refuses agent self-registration), so only the student form is offered.
  // Set AGENT_SELF_SIGN_UP to true to bring the Agent tab back.
  const [kind, setKind] = useState<SignUpIntent>(() => (AGENT_SELF_SIGN_UP ? readSignUpIntent() : "student"));
  const [studentReady, setStudentReady] = useState(false);
  const pick = (next: SignUpIntent) => { setKind(next); rememberSignUpIntent(next); };
  const tab = (value: SignUpIntent, label: string) => (
    <button type="button" role="tab" aria-selected={kind === value} onClick={() => pick(value)}
      className={`flex-1 cursor-pointer rounded-md px-3 py-2 text-center text-sm font-semibold transition-colors ${kind === value ? "bg-background-50 text-foreground-950 shadow-sm" : "text-foreground-600 hover:text-foreground-900"}`}>
      {label}
    </button>
  );
  if (studentReady) return <ApplyQuestion onAnswer={onStudentDone} />;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-primary-700">Almost done</p>
      <h2 className="mt-1 font-heading text-2xl font-bold text-foreground-950">{kind === "agent" ? "Agency details" : "Your details"}</h2>
      <p className="mt-1.5 text-sm text-foreground-600">You're signed in{user.email ? ` as ${user.email}` : user.phone ? ` with +${String(user.phone).replace(/^\+/, "")}` : ""}. Tell us who you are.</p>
      {AGENT_SELF_SIGN_UP ? (
        <div role="tablist" aria-label="Account type" className="mt-5 flex rounded-lg border border-background-300 bg-background-200 p-1">
          {tab("student", "Student")}
          {tab("agent", "Agent")}
        </div>
      ) : null}
      <div className="mt-5">
        {kind === "agent"
          ? <CompleteAgentProfile user={user} onDone={(name) => { rememberSignUpIntent(null); onAgentDone(name); }} />
          : <CompleteStudentProfile user={user} onDone={() => { rememberSignUpIntent(null); setStudentReady(true); }} onCancel={onCancel} embedded />}
      </div>
      {kind === "agent" ? <button type="button" onClick={onCancel} className="mt-3 w-full cursor-pointer text-center text-xs text-foreground-600 hover:text-foreground-900">Not you? Sign out</button> : null}
    </div>
  );
}

/** The student account exists: next step of the sign-up, start an application at SLIT now or go to the portal. */
export function ApplyQuestion({ onAnswer }: { onAnswer: (apply: boolean) => void }) {
  return (
    <div className="text-center">
      <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-primary-50 text-3xl text-primary-600"><i className="ri-graduation-cap-line" aria-hidden="true" /></span>
      <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-primary-700">Your account is ready</p>
      <h2 className="mt-1 font-heading text-2xl font-bold text-foreground-950">Do you want to apply at SLIT?</h2>
      <p className="mx-auto mt-2 max-w-sm text-sm text-foreground-600">Start your application now: upload your passport and we fill in your details. You can also come back to it later.</p>
      <div className="mt-6 space-y-2">
        <Button type="button" className="w-full" onClick={() => onAnswer(true)}>Yes, start my application</Button>
        <Button type="button" variant="outline" className="w-full" onClick={() => onAnswer(false)}>Not now</Button>
      </div>
    </div>
  );
}
