import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { EMPLOYMENT_TYPE_LABEL, JOB_APPLICATION_STATUS_LABEL, JOB_FILE_ACCEPT, applyProblems, jobApplyPath, jobFileProblem, jobPath, rememberJobIntent } from "@/lib/jobs";
import { applyForJob, getJob, uploadJobDocument, type Job } from "@/lib/jobsApi";
import { getMyStaffApplication, requestStaffCode, setStaffPassword, startStaffApplication, verifyStaffCode, type StaffMe } from "@/lib/staffApi";
import { toE164 } from "@/lib/staffPhone";

const MAX_LETTER = 5000;
const STEPS = ["Resume", "Your details", "Cover letter"];

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-background-200 bg-background-50 p-6 shadow-sm md:p-8">{children}</div>;
}
function Problem({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null;
}
const button = "rounded-md bg-primary-500 px-4 py-2.5 text-center text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:opacity-60";
const outline = "rounded-md border border-background-300 px-4 py-2.5 text-center text-sm font-semibold text-foreground-800 hover:bg-background-100";
const input = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none focus:border-primary-500";
const label = "mb-1.5 block text-[13px] font-medium text-foreground-800";

function Steps({ current }: { current: number }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2" aria-label="Steps">
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-2" aria-current={i === current ? "step" : undefined}>
          <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${i === current ? "bg-primary-500 text-background-50" : i < current ? "bg-secondary-100 text-secondary-800" : "bg-background-200 text-foreground-500"}`}>{i < current ? <i className="ri-check-line" aria-hidden="true" /> : i + 1}</span>
          <span className={`text-sm ${i === current ? "font-semibold text-foreground-950" : "text-foreground-600"}`}>{s}</span>
          {i < STEPS.length - 1 ? <span className="mx-1 h-px w-6 bg-background-300" aria-hidden="true" /> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * Apply for a job in three steps on one page: the resume first, then the person's email and mobile (their account is created
 * here: emailed code, then a password; an existing sign-in just adds the mobile), then the cover letter and Send. The resume is
 * held in the browser until the account exists, then stored in the private staff bucket. Sending creates the person's row in the
 * staff table with the status "Job applied"; if hired, they complete the staff registration with the same login.
 */
export default function CareerApplyPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined);
  const [step, setStep] = useState(0);
  const [resume, setResume] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJob(id).then((row) => { if (!cancelled) setJob(row); }, (e) => { if (!cancelled) { setJob(null); setError(e instanceof Error ? e.message : "The job could not be loaded."); } });
    void supabase.auth.getSession().then(({ data }) => { if (!cancelled) setUser(data.session?.user ?? null); });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => { if (!cancelled && session?.user) setUser(session.user); });
    return () => { cancelled = true; sub.subscription.unsubscribe(); };
  }, [id]);

  // Signed in: load the staff record (there is one after the sign-up, or after an earlier application).
  const loadMe = useCallback(async () => {
    try { setMe(await getMyStaffApplication()); }
    catch (e) { setMe(null); setError(e instanceof Error ? e.message : "We could not load your details."); }
  }, []);
  useEffect(() => { if (user) void loadMe(); else if (user === null) setMe(null); }, [user, loadMe]);

  const uid = user?.id ?? "";
  const hasResume = Boolean(me?.documents.some((d) => d.category === "Resume"));

  // The resume chosen in step 1 is stored once the account (and so the staff record) exists.
  const storeResume = async (record: StaffMe) => {
    if (!resume) return record;
    await uploadJobDocument(record, uid, "Resume", resume);
    const next = await getMyStaffApplication();
    if (next) setMe(next);
    setResume(null);
    return next ?? record;
  };

  const title = job?.title ?? "Apply";
  const seo = <Seo title={`Apply for ${title} | Skyline Institute Of Technology`} description="Apply online with your resume and cover letter." path={jobApplyPath(id)} />;
  const hero = <PageHero title={job ? `Apply: ${job.title}` : "Apply"} breadcrumb="Careers" lead={job ? `${EMPLOYMENT_TYPE_LABEL[job.employmentType]} · ${job.location}` : undefined} />;

  let body: ReactNode;
  if (job === undefined || user === undefined || (user && me === undefined)) {
    body = <p className="text-sm text-foreground-600" role="status">Loading…</p>;
  } else if (!job) {
    body = <Card><p className="text-sm text-foreground-700">This job post does not exist or has been removed.</p><p className="mt-4"><Link to="/careers" className={outline}>All openings</Link></p></Card>;
  } else if (job.status !== "open") {
    body = <Card><p className="text-sm text-foreground-700">Applications for <strong>{job.title}</strong> have closed.</p><p className="mt-4"><Link to="/careers" className={outline}>See other openings</Link></p></Card>;
  } else if (sent) {
    body = (
      <Card>
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-2xl text-primary-600"><i className="ri-check-line" aria-hidden="true" /></span>
        <h2 className="mt-4 font-heading text-2xl font-bold text-foreground-950">Application sent</h2>
        <p className="mt-2 text-sm text-foreground-700">Thank you for applying for <strong>{job.title}</strong>. Our team will review your application and get back to you. You can follow its progress, and complete your staff registration if you are hired, from your staff page.</p>
        <div className="mt-5 flex flex-wrap gap-2"><Link to="/staff" className={button}>My staff page</Link><Link to="/careers" className={outline}>More openings</Link></div>
      </Card>
    );
  } else if (me?.jobApplications.some((a) => a.jobId === job.id)) {
    const existing = me.jobApplications.find((a) => a.jobId === job.id)!;
    body = (
      <Card>
        <h2 className="font-heading text-xl font-bold text-foreground-950">You have already applied</h2>
        <p className="mt-2 text-sm text-foreground-700">You applied for <strong>{job.title}</strong> on {new Date(existing.appliedAt).toLocaleDateString("en-AU")}. Status: <strong>{JOB_APPLICATION_STATUS_LABEL[existing.status]}</strong>.</p>
        <div className="mt-5 flex flex-wrap gap-2"><Link to="/staff" className={button}>My staff page</Link><Link to="/careers" className={outline}>More openings</Link></div>
      </Card>
    );
  } else if (me && !["draft", "job_applied", "rejected"].includes(me.profile.status)) {
    body = <Card><p className="text-sm text-foreground-700">Your staff application is already with an administrator. Contact them about this role.</p><p className="mt-4"><Link to="/staff" className={outline}>My staff page</Link></p></Card>;
  } else if (step === 0) {
    body = (
      <Card>
        <Steps current={0} />
        <ResumeStep job={job} file={resume} stored={hasResume ? me!.documents.find((d) => d.category === "Resume")!.filename : ""} onFile={setResume}
          onNext={() => { setError(""); setStep(me ? 2 : 1); }} />
      </Card>
    );
  } else if (step === 1) {
    body = (
      <Card>
        <Steps current={1} />
        {user
          ? <AttachStep user={user} busy={busy} error={error} onSubmit={async (phone) => {
              setBusy(true); setError("");
              try { const record = await startStaffApplication(phone); await storeResume(record); setStep(2); }
              catch (e) { setError(e instanceof Error ? e.message : "We could not create your account."); }
              finally { setBusy(false); }
            }} />
          : <AccountStep jobId={id} onBack={() => setStep(0)} onReady={async () => {
              setBusy(true); setError("");
              try { const record = await startStaffApplication(); await storeResume(record); setStep(2); }
              catch (e) { setError(e instanceof Error ? e.message : "We could not create your account."); }
              finally { setBusy(false); }
            }} />}
        {!user && error ? <div className="mt-4"><Problem text={error} /></div> : null}
      </Card>
    );
  } else {
    body = (
      <Card>
        <Steps current={2} />
        <LetterStep job={job} me={me!} uid={uid} pendingResume={resume} onChange={setMe} onBack={() => setStep(0)}
          onSent={() => { rememberJobIntent(null); setSent(true); }} />
      </Card>
    );
  }

  return (
    <>
      {seo}
      {hero}
      <section className="bg-background-100 py-12 md:py-16">
        <div className="site-container max-w-3xl">
          {error && step !== 1 ? <div className="mb-4"><Problem text={error} /></div> : null}
          {body}
          {!sent && job?.status === "open" ? <p className="mt-4 text-xs text-foreground-500"><Link to={jobPath(id)} className="font-semibold text-primary-700 hover:underline">&larr; Back to the job</Link>{user ? <> · Signed in as {user.email}. <button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={() => { void supabase.auth.signOut().then(() => navigate(jobApplyPath(id), { replace: true })); }}>Not you?</button></> : null}</p> : null}
        </div>
      </section>
    </>
  );
}

/* ----------------------------------------------------------------- step 1: the resume */
function ResumeStep({ job, file, stored, onFile, onNext }: { job: Job; file: File | null; stored: string; onFile: (f: File | null) => void; onNext: () => void }) {
  const [problem, setProblem] = useState("");
  const pick = (f: File | undefined) => {
    if (!f) return;
    const p = jobFileProblem(f);
    setProblem(p);
    onFile(p ? null : f);
  };
  const shown = file?.name || stored;
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (!shown) { setProblem("Upload your resume to continue."); return; } onNext(); }} noValidate>
      <h2 className="font-heading text-xl font-bold text-foreground-950">Your resume</h2>
      <p className="mt-1 text-sm text-foreground-600">Start with your resume for <strong>{job.title}</strong>. PDF or Word, up to 10 MB.</p>
      <label htmlFor="job-resume" className="mt-5 flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed border-background-300 bg-background-100 px-4 py-8 text-center hover:border-primary-400">
        <i className="ri-upload-cloud-2-line text-3xl text-primary-600" aria-hidden="true" />
        {shown ? <span className="mt-2 text-sm font-semibold text-foreground-950"><i className="ri-checkbox-circle-fill text-secondary-700" aria-hidden="true" /> {shown}</span> : <span className="mt-2 text-sm font-semibold text-foreground-900">Choose your resume</span>}
        <span className="mt-1 text-xs text-foreground-500">{shown ? "Click to choose a different file" : ".pdf, .doc or .docx"}</span>
        <input id="job-resume" type="file" accept={JOB_FILE_ACCEPT} className="sr-only" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} data-testid="job-file-resume" />
      </label>
      <div className="mt-4"><Problem text={problem} /></div>
      <div className="mt-5 flex flex-wrap gap-2">
        <button type="submit" className={button} data-testid="job-resume-next">Continue</button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- step 2: email and mobile (a new account), or just the mobile */
function AttachStep({ user, busy, error, onSubmit }: { user: User; busy: boolean; error: string; onSubmit: (phone: string) => void }) {
  const [problem, setProblem] = useState("");
  return (
    <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); const phone = toE164(new FormData(e.currentTarget).get("apply-phone")); if (!phone) { setProblem("Enter your mobile number with its country code."); return; } setProblem(""); onSubmit(phone); }} noValidate className="space-y-4">
      <h2 className="font-heading text-xl font-bold text-foreground-950">Your details</h2>
      <p className="text-sm text-foreground-700">You are signed in as <strong>{user.email}</strong>. Add your mobile number to continue.</p>
      <div>
        <label htmlFor="apply-phone" className={label}>Mobile <span className="text-primary-600">*</span></label>
        <PhoneInput id="apply-phone" name="apply-phone" required placeholder="041 234 5678" />
      </div>
      <Problem text={problem || error} />
      <button type="submit" className={button} disabled={busy}>{busy ? "Saving…" : "Continue"}</button>
    </form>
  );
}

/**
 * A new account without leaving the page: email + mobile, the emailed code, then a password. The link in the email also works but
 * opens /staff/apply in a new tab, which comes back here without the chosen resume; typing the code keeps everything on this page.
 */
function AccountStep({ jobId, onBack, onReady }: { jobId: string; onBack: () => void; onReady: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [website, setWebsite] = useState("");
  const [stage, setStage] = useState<"details" | "code" | "password">("details");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const mobile = String(new FormData(event.currentTarget).get("apply-mobile") ?? "");
    setPhone(mobile);
    if (!/^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$/.test(email.trim())) { setProblem("Enter a valid email address."); return; }
    if (!toE164(mobile)) { setProblem("Enter your mobile number with its country code."); return; }
    if (!agreed) { setProblem("Please agree to the terms and privacy policy."); return; }
    setBusy(true); setProblem("");
    try { rememberJobIntent(jobId); await requestStaffCode(email.trim().toLowerCase(), toE164(mobile)!, agreed, website); setStage("code"); }
    catch (e) { setProblem(e instanceof Error ? e.message : "We could not send the email. Please try again."); }
    finally { setBusy(false); }
  };
  const verify = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (!/^\d{6,8}$/.test(code.trim())) { setProblem("Enter the code from the email."); return; }
    setBusy(true); setProblem("");
    try { await verifyStaffCode(email, code); setStage("password"); }
    catch (e) { setProblem(e instanceof Error ? e.message : "That code is not right."); }
    finally { setBusy(false); }
  };
  const choose = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (password.length < MIN_PASSWORD_LENGTH) { setProblem(`Use at least ${MIN_PASSWORD_LENGTH} characters.`); return; }
    if (password !== again) { setProblem("The two passwords do not match."); return; }
    setBusy(true); setProblem("");
    try { await setStaffPassword(password); await onReady(); }
    catch (e) { setProblem(e instanceof Error ? e.message : "We could not save your password."); }
    finally { setBusy(false); }
  };

  if (stage === "code") {
    return (
      <form onSubmit={verify} noValidate className="space-y-4">
        <h2 className="font-heading text-xl font-bold text-foreground-950">Check your email</h2>
        <p className="text-sm text-foreground-700" role="status">We emailed <strong>{email.trim().toLowerCase()}</strong>. Type the code it shows to continue here.</p>
        <div><label htmlFor="apply-code" className={label}>Code from the email</label><input id="apply-code" className={input} inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123456" data-testid="job-code" /></div>
        <Problem text={problem} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={button} disabled={busy}>{busy ? "Checking…" : "Verify email"}</button>
          <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" disabled={busy}
            onClick={() => { setBusy(true); void requestStaffCode(email.trim().toLowerCase(), toE164(phone)!, agreed).then(() => setProblem(""), (e) => setProblem(e instanceof Error ? e.message : "We could not send the email.")).finally(() => setBusy(false)); }}>Send a new code</button>
        </div>
      </form>
    );
  }
  if (stage === "password") {
    return (
      <form onSubmit={choose} noValidate className="space-y-4">
        <h2 className="font-heading text-xl font-bold text-foreground-950">Choose a password</h2>
        <p className="text-sm text-foreground-700">Your email is confirmed. You sign in with it and this password to follow your application.</p>
        <div><label htmlFor="apply-password" className={label}>Password <span className="text-primary-600">*</span></label><input id="apply-password" type="password" autoComplete="new-password" className={input} value={password} onChange={(e) => setPassword(e.target.value)} data-testid="job-password" /><p className="mt-1 text-xs text-foreground-500">At least {MIN_PASSWORD_LENGTH} characters.</p></div>
        <div><label htmlFor="apply-again" className={label}>Repeat password <span className="text-primary-600">*</span></label><input id="apply-again" type="password" autoComplete="new-password" className={input} value={again} onChange={(e) => setAgain(e.target.value)} /></div>
        <Problem text={problem} />
        <button type="submit" className={button} disabled={busy} data-testid="job-password-save">{busy ? "Saving…" : "Save password and continue"}</button>
      </form>
    );
  }
  return (
    <form onSubmit={send} noValidate className="space-y-4">
      <h2 className="font-heading text-xl font-bold text-foreground-950">Your details</h2>
      <p className="text-sm text-foreground-700">We create your account with these details, so you can follow your application and, if you are hired, complete your staff registration with the same login.</p>
      <div><label htmlFor="apply-email" className={label}>Email <span className="text-primary-600">*</span></label><input id="apply-email" type="email" autoComplete="email" className={input} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="job-email" /></div>
      <div>
        <label htmlFor="apply-mobile" className={label}>Mobile <span className="text-primary-600">*</span></label>
        <PhoneInput id="apply-mobile" name="apply-mobile" value={phone} required placeholder="041 234 5678" />
      </div>
      <input type="text" name="website" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
      <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-700">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4" data-testid="job-agree" />
        <span>I agree to the <Link to="/forms-policies" className="font-semibold text-primary-700 hover:underline">terms and privacy policy</Link>.</span>
      </label>
      <Problem text={problem} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={button} disabled={busy} data-testid="job-send-code">{busy ? "Sending…" : "Email me a code"}</button>
        <button type="button" className={outline} onClick={onBack}>Back</button>
        <button type="button" className="cursor-pointer text-sm font-semibold text-primary-700 hover:underline" onClick={() => { rememberJobIntent(jobId); navigate(`/login?next=${encodeURIComponent(jobApplyPath(jobId))}`); }}>I already have an account</button>
      </div>
    </form>
  );
}

/* ----------------------------------------------------------------- step 3: the cover letter, then send */
function LetterStep({ job, me, uid, pendingResume, onChange, onBack, onSent }: { job: Job; me: StaffMe; uid: string; pendingResume: File | null; onChange: (me: StaffMe) => void; onBack: () => void; onSent: () => void }) {
  const resume = me.documents.find((d) => d.category === "Resume");
  const coverFile = me.documents.find((d) => d.category === "Cover Letter");
  const [letter, setLetter] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<string[]>([]);

  const uploadCover = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true); setError("");
    try { await uploadJobDocument(me, uid, "Cover Letter", file); const next = await getMyStaffApplication(); if (next) onChange(next); }
    catch (e) { setError(e instanceof Error ? e.message : "The upload failed."); }
    finally { setUploading(false); }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const missing = applyProblems({ hasResume: Boolean(resume || pendingResume), coverLetter: letter, hasCoverLetterFile: Boolean(coverFile) });
    setProblems(missing);
    if (missing.length) return;
    setBusy(true); setError("");
    try {
      let record = me, resumeId = resume?.id ?? "";
      if (!resumeId && pendingResume) {
        const stored = await uploadJobDocument(record, uid, "Resume", pendingResume);
        resumeId = stored.id;
        record = (await getMyStaffApplication()) ?? record;
      }
      onChange(await applyForJob(job.id, letter, resumeId, coverFile?.id ?? null));
      onSent();
    } catch (e) { setError(e instanceof Error ? e.message : "Your application could not be sent."); }
    finally { setBusy(false); }
  };

  return (
    <form onSubmit={send} className="space-y-5" noValidate>
      <div>
        <h2 className="font-heading text-xl font-bold text-foreground-950">Cover letter</h2>
        <p className="mt-1 text-sm text-foreground-600">Applying for <strong>{job.title}</strong> as {me.profile.email} · {me.profile.phone_e164}. Resume: <strong>{resume?.filename ?? pendingResume?.name}</strong> (<button type="button" className="cursor-pointer font-semibold text-primary-700 hover:underline" onClick={onBack}>change</button>)</p>
      </div>
      <div>
        <label htmlFor="job-letter" className={label}>Cover letter <span className="text-primary-600">*</span></label>
        <textarea id="job-letter" rows={8} maxLength={MAX_LETTER} value={letter} onChange={(e) => setLetter(e.target.value)} placeholder={`Tell us why you are applying for ${job.title} and what you bring to the role.`} className={input} data-testid="job-cover-letter" />
        <p className="mt-1 text-right text-xs text-foreground-500">{letter.length} / {MAX_LETTER}</p>
      </div>
      <div>
        <label htmlFor="job-cover-file" className={label}>Cover letter as a file <span className="text-foreground-500">(optional)</span></label>
        {coverFile ? <p className="mb-2 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm"><i className="ri-checkbox-circle-fill text-secondary-700" aria-hidden="true" /> {coverFile.filename} <label htmlFor="job-cover-file" className="ml-2 cursor-pointer text-xs font-semibold text-primary-700 hover:underline">Replace</label></p> : null}
        <input id="job-cover-file" type="file" accept={JOB_FILE_ACCEPT} disabled={uploading} onChange={(e) => { void uploadCover(e.target.files?.[0]); e.target.value = ""; }}
          className={`block w-full text-sm text-foreground-700 file:mr-3 file:rounded-md file:border-0 file:bg-background-200 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-foreground-800 ${coverFile ? "sr-only" : ""}`} data-testid="job-file-cover-letter" />
        <p className="mt-1 text-xs text-foreground-500">{uploading ? "Uploading…" : "PDF or Word, up to 10 MB."}</p>
      </div>
      {problems.length ? <ul role="alert" className="list-disc space-y-1 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 pl-7 text-sm text-primary-900">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      <Problem text={error} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={button} disabled={busy || uploading} data-testid="job-send">{busy ? "Sending…" : "Send application"}</button>
        <button type="button" className={outline} onClick={onBack}>Back</button>
      </div>
    </form>
  );
}
