import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { PhoneInput } from "@/components/feature/applicationInputs";
import StaffCaptcha, { captchaConfigured } from "@/components/feature/StaffCaptcha";
import { COVER_LETTER_MAX, EMPLOYMENT_TYPE_LABEL, JOB_FILE_ACCEPT, applyProblems, jobApplyPath, jobFileProblem, jobPath } from "@/lib/jobs";
import { getJob, type Job } from "@/lib/jobsApi";
import { applyAsStaff } from "@/lib/staffApi";
import { readResumeContact, type ResumeContact } from "@/lib/resumeContact";
import { toE164 } from "@/lib/staffPhone";

/**
 * /careers/:id/apply (HR-02i): the same no-login application as Enroll now > Staff, with the job attached and an optional cover
 * letter (text and/or a PDF or Word .docx file). No account is created: staff-register checks the security challenge, rate limits and
 * the files by content, records the application with this job, and we email the person if we would like to continue. An address that
 * already has an application gets the same thank-you (the job is added to it).
 */

function Card({ children }: { children: ReactNode }) {
  return <div className="rounded-card border border-background-200 bg-background-50 p-6 shadow-sm md:p-8">{children}</div>;
}
const button = "rounded-md bg-primary-500 px-4 py-2.5 text-center text-sm font-semibold text-background-50 hover:bg-primary-600 disabled:opacity-60";
const outline = "rounded-md border border-background-300 px-4 py-2.5 text-center text-sm font-semibold text-foreground-800 hover:bg-background-100";
const input = "w-full rounded-md border border-background-300 bg-background-50 px-3 py-2 text-sm text-foreground-900 outline-none focus:border-primary-500";
const label = "mb-1.5 block text-[13px] font-medium text-foreground-800";
const problem = (text?: string) => (text ? <span className="mt-1 block text-xs text-primary-700" role="alert">{text}</span> : null);

export default function CareerApplyPage() {
  const { id = "" } = useParams();
  const [job, setJob] = useState<Job | null | undefined>(undefined);
  const [loadError, setLoadError] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [suggestedPhone, setSuggestedPhone] = useState("");
  const [resumeRead, setResumeRead] = useState<"idle" | "reading" | "found" | "manual">("idle");
  const edited = useRef(new Set<keyof ResumeContact>());
  const [coverLetter, setCoverLetter] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [agreed, setAgreed] = useState(false);
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getJob(id).then((row) => { if (!cancelled) setJob(row); }, (e) => { if (!cancelled) { setJob(null); setLoadError(e instanceof Error ? e.message : "The job could not be loaded."); } });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!resume) return;
    const controller = new AbortController();
    const applySuggestions = (details: ResumeContact) => {
      const updates = [
        ["firstName", setFirstName], ["lastName", setLastName], ["email", setEmail], ["phone", setSuggestedPhone],
      ] as const;
      const eligible = updates.filter(([key]) => !edited.current.has(key));
      for (const [key, set] of eligible) set(details[key] ?? "");
      setResumeRead(eligible.some(([key]) => details[key]) ? "found" : "manual");
    };
    const timeout = window.setTimeout(() => { controller.abort(); applySuggestions({}); }, 5000);
    void readResumeContact(resume, controller.signal).catch(() => ({})).then((details) => {
      if (!controller.signal.aborted) applySuggestions(details);
    }).finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [resume]);

  const pickFile = (key: "resume" | "coverLetterFile", file: File | null) => {
    const p = file ? jobFileProblem(file) : "";
    setErrors((e) => ({ ...e, [key]: p }));
    if (key === "resume") {
      const next = p ? null : file;
      if (!edited.current.has("firstName")) setFirstName("");
      if (!edited.current.has("lastName")) setLastName("");
      if (!edited.current.has("email")) setEmail("");
      if (!edited.current.has("phone")) setSuggestedPhone("");
      setResumeRead(next ? "reading" : "idle");
      setResume(next);
    } else {
      setCoverFile(p ? null : file);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!job || busy || resumeRead === "reading") return;
    const mobile = String(new FormData(event.currentTarget).get("job-mobile") ?? "");
    const next: Record<string, string> = {};
    if (!firstName.trim()) next.firstName = "Enter your first name.";
    if (!lastName.trim()) next.lastName = "Enter your last name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) next.email = "Enter a valid email address.";
    if (!toE164(mobile)) next.phone = "Enter your mobile number.";
    for (const p of applyProblems({ hasResume: Boolean(resume), coverLetter })) next[p.startsWith("Attach") ? "resume" : "coverLetter"] = p;
    if (!agreed) next.agreed = "Please agree to the terms and privacy policy.";
    if (!captchaToken) next.captcha = "Complete the security check.";
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    try {
      await applyAsStaff({ firstName: firstName.trim(), lastName: lastName.trim(), email: email.trim().toLowerCase(), phone: toE164(mobile)!, resume: resume!, agreed, captchaToken,
        jobId: job.id, coverLetter, coverLetterFile: coverFile });
      setSent(true);
    } catch (e) {
      const field = (e as { field?: string }).field ?? "form";
      setErrors({ [field === "jobId" ? "form" : field]: e instanceof Error ? e.message : "We could not send your application. Please try again." });
      setCaptchaToken(""); setCaptchaReset((n) => n + 1);
    } finally { setBusy(false); }
  };

  const title = job?.title ?? "a job";
  const seo = <Seo title={`Apply for ${title} | Skyline Institute Of Technology`} description="Apply online with your resume and an optional cover letter." path={jobApplyPath(id)} />;
  const hero = <PageHero title={job ? `Apply: ${job.title}` : "Apply"} breadcrumb="Careers" lead={job ? `${EMPLOYMENT_TYPE_LABEL[job.employmentType]} · ${job.location}` : undefined} />;

  let body: ReactNode;
  if (job === undefined) body = <Card><p className="text-sm text-foreground-600" role="status">Loading…</p></Card>;
  else if (job === null) body = <Card><p className="text-sm text-foreground-700">{loadError || "This job could not be found."}</p><p className="mt-4"><Link to="/careers" className={outline}>All jobs</Link></p></Card>;
  else if (job.status !== "open") body = <Card><p className="text-sm text-foreground-700">Applications for <strong>{job.title}</strong> have closed.</p><p className="mt-4"><Link to="/careers" className={outline}>All jobs</Link></p></Card>;
  else if (sent) {
    body = (
      <Card>
        <div data-testid="job-apply-thanks" role="status">
          <h2 className="font-heading text-xl font-bold text-foreground-950">Thank you for applying</h2>
          <p className="mt-2 text-sm text-foreground-700">We have received your application for <strong>{job.title}</strong>. An administrator will review it, and if we would like to continue we will email you a private link to add your details and documents. You do not need an account.</p>
          <p className="mt-4"><Link to="/careers" className={outline}>All jobs</Link></p>
        </div>
      </Card>
    );
  } else {
    body = (
      <Card>
        <form onSubmit={(e) => void submit(e)} noValidate className="space-y-4" data-testid="job-apply-form">
          {errors.form ? <p role="alert" className="rounded-md border border-primary-200 bg-primary-50 px-3 py-2 text-sm text-primary-900">{errors.form}</p> : null}
          <div>
            <label className={label} htmlFor="job-resume">Resume (PDF or Word .docx, 5 MB) <span className="text-primary-600">*</span></label>
            <input id="job-resume" type="file" accept={JOB_FILE_ACCEPT} onChange={(e) => pickFile("resume", e.target.files?.[0] ?? null)} className="block w-full text-sm" data-testid="job-apply-resume" />
            {problem(errors.resume)}
            <p className="mt-2 text-sm text-foreground-600" role="status">
              {resumeRead === "reading" ? "Reading contact details from your resume…"
                : resumeRead === "found" ? "Check the details filled from your resume and correct anything missing or inaccurate."
                : resumeRead === "manual" ? "You can enter any remaining contact details below."
                : "Choose your resume to fill in your contact details automatically."}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><label className={label} htmlFor="job-first">First name <span className="text-primary-600">*</span></label><input id="job-first" className={input} value={firstName} onChange={(e) => { edited.current.add("firstName"); setFirstName(e.target.value); }} autoComplete="given-name" maxLength={100} data-testid="job-apply-first-name" />{problem(errors.firstName)}</div>
            <div><label className={label} htmlFor="job-last">Last name <span className="text-primary-600">*</span></label><input id="job-last" className={input} value={lastName} onChange={(e) => { edited.current.add("lastName"); setLastName(e.target.value); }} autoComplete="family-name" maxLength={100} data-testid="job-apply-last-name" />{problem(errors.lastName)}</div>
          </div>
          <div><label className={label} htmlFor="job-email">Email <span className="text-primary-600">*</span></label><input id="job-email" type="email" className={input} value={email} onChange={(e) => { edited.current.add("email"); setEmail(e.target.value); }} autoComplete="email" data-testid="job-apply-email" />{problem(errors.email)}</div>
          <div onInput={() => { edited.current.add("phone"); }} onChangeCapture={() => { edited.current.add("phone"); }}><label className={label} htmlFor="job-mobile">Mobile <span className="text-primary-600">*</span></label><PhoneInput key={suggestedPhone} id="job-mobile" name="job-mobile" value={suggestedPhone} required placeholder="041 234 5678" />{problem(errors.phone)}</div>
          <div>
            <label className={label} htmlFor="job-letter">Cover letter (optional)</label>
            <textarea id="job-letter" rows={6} maxLength={COVER_LETTER_MAX} className={input} value={coverLetter} onChange={(e) => setCoverLetter(e.target.value)} data-testid="job-apply-cover-letter" />
            <span className="mt-1 block text-xs text-foreground-500">{coverLetter.length}/{COVER_LETTER_MAX}. Or attach it as a file below.</span>
            {problem(errors.coverLetter)}
          </div>
          <div>
            <label className={label} htmlFor="job-cover-file">Cover letter file (optional, PDF or Word .docx, 5 MB)</label>
            <input id="job-cover-file" type="file" accept={JOB_FILE_ACCEPT} onChange={(e) => pickFile("coverLetterFile", e.target.files?.[0] ?? null)} className="block w-full text-sm" data-testid="job-apply-cover-file" />
            {problem(errors.coverLetterFile)}
          </div>
          <label className="flex cursor-pointer items-start gap-2.5 text-sm text-foreground-700">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} className="mt-0.5 h-4 w-4 rounded border-background-400" data-testid="job-apply-agree" />
            <span>I agree to the <Link to="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">terms</Link> and <Link to="/forms-policies" target="_blank" rel="noopener" className="font-medium text-primary-700 hover:underline">privacy policy</Link>.</span>
          </label>
          {problem(errors.agreed)}
          <StaffCaptcha onToken={setCaptchaToken} resetKey={captchaReset} />
          {problem(errors.captcha)}
          <button type="submit" className={`${button} w-full`} disabled={busy || !captchaConfigured || resumeRead === "reading"} data-testid="job-apply-submit">{busy ? "Sending…" : "Send application"}</button>
        </form>
      </Card>
    );
  }

  return (
    <>
      {seo}
      {hero}
      <section className="bg-background-100 py-12 md:py-16">
        <div className="site-container max-w-3xl">
          {body}
          {!sent && job?.status === "open" ? <p className="mt-4 text-xs text-foreground-500"><Link to={jobPath(id)} className="font-semibold text-primary-700 hover:underline">&larr; Back to the job</Link></p> : null}
        </div>
      </section>
    </>
  );
}
