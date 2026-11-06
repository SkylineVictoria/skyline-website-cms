import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { PhoneInput } from "@/components/feature/applicationInputs";
import { EMPLOYMENT_TYPE_LABEL, JOB_APPLICATION_STATUS_LABEL, JOB_FILE_ACCEPT, applyProblems, jobApplyPath, jobPath, rememberJobIntent } from "@/lib/jobs";
import { applyForJob, getJob, uploadJobDocument, type Job } from "@/lib/jobsApi";
import { getMyStaffApplication, startStaffApplication, type StaffMe } from "@/lib/staffApi";
import { toE164 } from "@/lib/staffPhone";

const MAX_LETTER = 5000;

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-background-200 bg-background-50 p-6 shadow-sm md:p-8">{children}</div>;
}
function Problem({ text }: { text: string }) {
  return text ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{text}</p> : null;
}
const button = "rounded-md bg-primary-500 px-4 py-2.5 text-center text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:opacity-60";
const outline = "rounded-md border border-background-300 px-4 py-2.5 text-center text-sm font-semibold text-foreground-800 hover:bg-background-100";

/**
 * Apply for a job. The person needs an account first (the staff sign-up: email + mobile, emailed code, password), so a hire later
 * continues on the same login. Signed in, they upload a resume, write or upload a cover letter and send it; this creates their row
 * in the staff table with the status "Job applied".
 */
export default function CareerApplyPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [me, setMe] = useState<StaffMe | null | undefined>(undefined);
  const [uid, setUid] = useState("");
  const [needPhone, setNeedPhone] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJob(id).then((row) => { if (!cancelled) setJob(row); }, (e) => { if (!cancelled) { setJob(null); setError(e instanceof Error ? e.message : "The job could not be loaded."); } });
    void supabase.auth.getSession().then(({ data }) => { if (!cancelled) { setUser(data.session?.user ?? null); setUid(data.session?.user.id ?? ""); } });
    return () => { cancelled = true; };
  }, [id]);

  // Signed in: load the staff profile, creating it when the sign-up left the mobile number in the account (otherwise ask for it).
  const loadMe = useCallback(async () => {
    try {
      const existing = await getMyStaffApplication();
      if (existing) { setMe(existing); return; }
      try { setMe(await startStaffApplication()); }
      catch { setMe(null); setNeedPhone(true); }
    } catch (e) { setMe(null); setError(e instanceof Error ? e.message : "We could not load your details."); }
  }, []);
  useEffect(() => { if (user) void loadMe(); }, [user, loadMe]);

  const createAccount = () => { rememberJobIntent(id); navigate("/login?mode=enroll&as=staff"); };
  const signIn = () => { rememberJobIntent(id); navigate(`/login?next=${encodeURIComponent(jobApplyPath(id))}`); };

  const attach = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    const phone = toE164(new FormData(event.currentTarget).get("apply-phone"));
    if (!phone) { setError("Enter your mobile number with its country code."); return; }
    setBusy(true); setError("");
    try { setMe(await startStaffApplication(phone)); setNeedPhone(false); }
    catch (e) { setError(e instanceof Error ? e.message : "We could not create your account."); }
    finally { setBusy(false); }
  };

  const title = job?.title ?? "Apply";
  const hero = <PageHero title={job ? `Apply: ${job.title}` : "Apply"} breadcrumb="Careers" lead={job ? `${EMPLOYMENT_TYPE_LABEL[job.employmentType]} · ${job.location}` : undefined} />;
  const seo = <Seo title={`Apply for ${title} | Skyline Institute Of Technology`} description="Apply online with your resume and cover letter." path={jobApplyPath(id)} />;

  let body: ReactNode;
  if (job === undefined || user === undefined || (user && me === undefined && !needPhone)) {
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
  } else if (!user) {
    body = (
      <Card>
        <h2 className="font-heading text-xl font-bold text-foreground-950">First, your account</h2>
        <p className="mt-2 text-sm text-foreground-700">We create your account before you apply: it takes your email, your mobile number and a password. If you are hired, you complete your staff registration with the same login, with no need to enroll again.</p>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button type="button" onClick={createAccount} className={button} data-testid="job-create-account">Create an account and apply</button>
          <button type="button" onClick={signIn} className={outline}>I already have an account: sign in</button>
        </div>
        <p className="mt-4 text-xs text-foreground-500"><Link to={jobPath(id)} className="font-semibold text-primary-700 hover:underline">&larr; Back to the job</Link></p>
      </Card>
    );
  } else if (needPhone || !me) {
    body = (
      <Card>
        <h2 className="font-heading text-xl font-bold text-foreground-950">One more detail</h2>
        <p className="mt-2 text-sm text-foreground-700">You are signed in as <strong>{user.email}</strong>. Add your mobile number to finish setting up your account, then apply.</p>
        <form onSubmit={attach} className="mt-5 space-y-4" noValidate>
          <div>
            <label htmlFor="apply-phone" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Mobile <span className="text-primary-600">*</span></label>
            <PhoneInput id="apply-phone" name="apply-phone" required placeholder="041 234 5678" />
          </div>
          <Problem text={error} />
          <button type="submit" className={button} disabled={busy}>{busy ? "Saving…" : "Continue"}</button>
        </form>
      </Card>
    );
  } else {
    const existing = me.jobApplications.find((a) => a.jobId === job.id);
    if (existing) {
      body = (
        <Card>
          <h2 className="font-heading text-xl font-bold text-foreground-950">You have already applied</h2>
          <p className="mt-2 text-sm text-foreground-700">You applied for <strong>{job.title}</strong> on {new Date(existing.appliedAt).toLocaleDateString("en-AU")}. Status: <strong>{JOB_APPLICATION_STATUS_LABEL[existing.status]}</strong>.</p>
          <div className="mt-5 flex flex-wrap gap-2"><Link to="/staff" className={button}>My staff page</Link><Link to="/careers" className={outline}>More openings</Link></div>
        </Card>
      );
    } else if (!["draft", "job_applied", "rejected"].includes(me.profile.status)) {
      body = <Card><p className="text-sm text-foreground-700">Your staff application is already with an administrator. Contact them about this role.</p><p className="mt-4"><Link to="/staff" className={outline}>My staff page</Link></p></Card>;
    } else {
      body = <ApplyForm job={job} me={me} uid={uid} onChange={setMe} onSent={() => { rememberJobIntent(null); setSent(true); }} />;
    }
  }

  return (
    <>
      {seo}
      {hero}
      <section className="bg-background-100 py-12 md:py-16">
        <div className="site-container max-w-3xl">{error && !needPhone ? <div className="mb-4"><Problem text={error} /></div> : null}{body}</div>
      </section>
    </>
  );
}

/** Resume (required), cover letter (typed, uploaded, or both), then send. Files go to the private staff bucket. */
function ApplyForm({ job, me, uid, onChange, onSent }: { job: Job; me: StaffMe; uid: string; onChange: (me: StaffMe) => void; onSent: () => void }) {
  const resume = me.documents.find((d) => d.category === "Resume");
  const coverFile = me.documents.find((d) => d.category === "Cover Letter");
  const [letter, setLetter] = useState("");
  const [uploading, setUploading] = useState<"Resume" | "Cover Letter" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [problems, setProblems] = useState<string[]>([]);

  const upload = async (category: "Resume" | "Cover Letter", file: File | undefined) => {
    if (!file) return;
    setUploading(category); setError("");
    try {
      await uploadJobDocument(me, uid, category, file);
      const next = await getMyStaffApplication();
      if (next) onChange(next);
    } catch (e) { setError(e instanceof Error ? e.message : "The upload failed."); }
    finally { setUploading(null); }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const missing = applyProblems({ hasResume: Boolean(resume), coverLetter: letter, hasCoverLetterFile: Boolean(coverFile) });
    setProblems(missing);
    if (missing.length) return;
    setBusy(true); setError("");
    try { onChange(await applyForJob(job.id, letter, resume!.id, coverFile?.id ?? null)); onSent(); }
    catch (e) { setError(e instanceof Error ? e.message : "Your application could not be sent."); }
    finally { setBusy(false); }
  };

  const fileRow = (category: "Resume" | "Cover Letter", doc: typeof resume, required: boolean, inputId: string) => (
    <div>
      <label htmlFor={inputId} className="mb-1.5 block text-[13px] font-medium text-foreground-800">{category}{required ? <span className="text-primary-600"> *</span> : <span className="text-foreground-500"> (optional file)</span>}</label>
      {doc ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-md border border-secondary-300 bg-secondary-50 px-3 py-2 text-sm">
          <span className="min-w-0 truncate"><i className="ri-checkbox-circle-fill text-secondary-700" aria-hidden="true" /> {doc.filename}</span>
          <label htmlFor={inputId} className="shrink-0 cursor-pointer text-xs font-semibold text-primary-700 hover:underline">Replace</label>
        </div>
      ) : null}
      <input id={inputId} type="file" accept={JOB_FILE_ACCEPT} disabled={uploading !== null} onChange={(e) => { void upload(category, e.target.files?.[0]); e.target.value = ""; }}
        className={`block w-full text-sm text-foreground-700 file:mr-3 file:rounded-md file:border-0 file:bg-background-200 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-foreground-800 ${doc ? "sr-only" : ""}`} data-testid={`job-file-${category.toLowerCase().replace(/\s+/g, "-")}`} />
      {uploading === category ? <p className="mt-1 text-xs text-foreground-500" role="status">Uploading…</p> : <p className="mt-1 text-xs text-foreground-500">PDF or Word, up to 10 MB.</p>}
    </div>
  );

  return (
    <Card>
      <h2 className="font-heading text-xl font-bold text-foreground-950">Your application</h2>
      <p className="mt-1 text-sm text-foreground-600">Applying as <strong>{me.profile.email}</strong> · {me.profile.phone_e164}</p>
      <form onSubmit={send} className="mt-6 space-y-5" noValidate>
        {fileRow("Resume", resume, true, "job-resume")}
        <div>
          <label htmlFor="job-letter" className="mb-1.5 block text-[13px] font-medium text-foreground-800">Cover letter <span className="text-primary-600">*</span></label>
          <textarea id="job-letter" rows={8} maxLength={MAX_LETTER} value={letter} onChange={(e) => setLetter(e.target.value)} placeholder={`Tell us why you are applying for ${job.title} and what you bring to the role.`}
            className="w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none focus:border-primary-500" data-testid="job-cover-letter" />
          <p className="mt-1 text-right text-xs text-foreground-500">{letter.length} / {MAX_LETTER}</p>
        </div>
        {fileRow("Cover Letter", coverFile, false, "job-cover-file")}
        {problems.length ? <ul role="alert" className="list-disc space-y-1 rounded-md border border-primary-200 bg-primary-50 px-3 py-2 pl-7 text-sm text-primary-900">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
        <Problem text={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="submit" className={button} disabled={busy || uploading !== null} data-testid="job-send">{busy ? "Sending…" : "Send application"}</button>
          <Link to={jobPath(job.id)} className="text-sm font-semibold text-primary-700 hover:underline">Back to the job</Link>
        </div>
      </form>
    </Card>
  );
}
