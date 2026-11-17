import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";

export type Completion = { id: string; enrolmentId: string; studentId: string; kind: "certificate" | "statement"; certificateNo: string; studentName: string;
  courseCode: string; courseName: string; units: { code: string; name: string; outcome: string | null; date: string | null }[]; issuedAt: string;
  issuedByName: string; revokedAt: string | null; revokeReason: string | null };

const INSTITUTE = "Skyline Institute of Technology";
const RTO = "RTO Code 45989 · CRICOS 04114B";
const LOGO = "https://slit.edu.au/wp-content/uploads/2023/06/logo-2.png";
const longDate = (d: string) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

/** A printable Certificate (with its record of results) or Statement of Attainment, for staff or the student it belongs to. */
export default function CertificatePage() {
  const { id = "" } = useParams();
  const [c, setC] = useState<Completion | null | undefined>(undefined);
  const [error, setError] = useState("");
  useEffect(() => {
    supabase.rpc("course_completion_get", { p_id: id }).then(({ data, error: e }) => {
      if (e) { setError(/Not allowed|42501/.test(e.message) ? "You cannot open this document." : e.message); setC(null); } else setC((data as Completion | null) ?? null);
    });
  }, [id]);

  if (c === undefined) return <p className="p-8 text-sm text-gray-600">Loading…</p>;
  if (!c) return <p role="alert" className="p-8 text-sm text-red-700">{error || "This document could not be found. Please sign in and try again."}</p>;
  const cert = c.kind === "certificate";
  const page = "mx-auto my-6 flex min-h-[260mm] w-full max-w-[200mm] flex-col border border-gray-300 bg-white p-12 text-center shadow print:my-0 print:min-h-[277mm] print:border-0 print:shadow-none";
  const results = (
    <table className="mt-6 w-full border-collapse text-left text-sm">
      <thead><tr className="border-b-2 border-gray-800"><th className="py-2 pr-3">Unit code</th><th className="py-2 pr-3">Unit title</th><th className="py-2 pr-3">Result</th><th className="py-2">Date</th></tr></thead>
      <tbody>{c.units.map((u) => (
        <tr key={u.code + u.name} className="border-b border-gray-200"><td className="py-1.5 pr-3 font-mono">{u.code}</td><td className="py-1.5 pr-3">{u.name}</td>
          <td className="py-1.5 pr-3">{u.outcome === "C" ? "Competent" : u.outcome === "NYC" ? "Not yet competent" : "—"}</td><td className="py-1.5">{u.date ? longDate(u.date) : ""}</td></tr>
      ))}</tbody>
    </table>
  );
  const footer = <p className="mt-auto pt-10 text-xs text-gray-600">{INSTITUTE} · {RTO} · {cert ? "Certificate" : "Statement"} No. {c.certificateNo} · Issued {longDate(c.issuedAt)}</p>;

  return (
    <div className="min-h-screen bg-gray-100 px-4 py-4 print:bg-white print:p-0">
      <div className="mx-auto flex max-w-[200mm] flex-wrap items-center justify-between gap-3 print:hidden">
        <p className="text-sm text-gray-700">{cert ? "Certificate and record of results" : "Statement of attainment"} · {c.certificateNo}</p>
        <button type="button" onClick={() => window.print()} className="rounded-md bg-gray-900 px-4 py-2 text-sm font-semibold text-white"><i className="ri-printer-line" aria-hidden="true" /> Print or save as PDF</button>
      </div>
      {c.revokedAt ? <p role="alert" className="mx-auto mt-3 max-w-[200mm] rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">This document was revoked on {longDate(c.revokedAt)}: {c.revokeReason}. It is not valid.</p> : null}
      <section className={page}>
        <img src={LOGO} alt={INSTITUTE} className="mx-auto h-20 object-contain" />
        <p className="mt-10 text-sm uppercase tracking-[0.3em] text-gray-600">{INSTITUTE}</p>
        <h1 className="mt-4 font-serif text-4xl font-bold text-gray-900">{cert ? "Certificate" : "Statement of Attainment"}</h1>
        <p className="mt-10 text-gray-700">This is to certify that</p>
        <p className="mt-3 font-serif text-3xl font-semibold text-gray-900">{c.studentName}</p>
        {cert ? (
          <>
            <p className="mt-8 text-gray-700">has fulfilled the requirements for</p>
            <p className="mt-3 text-2xl font-semibold text-gray-900">{c.courseCode} {c.courseName}</p>
          </>
        ) : (
          <>
            <p className="mt-8 text-gray-700">has attained the following unit{c.units.length === 1 ? "" : "s"} of competency</p>
            <p className="mt-1 text-sm text-gray-600">from {c.courseCode} {c.courseName}</p>
            <div className="mx-auto w-full max-w-[160mm]">{results}</div>
            <p className="mt-6 text-xs text-gray-600">These units are a partial completion of the qualification.</p>
          </>
        )}
        <div className="mt-16 grid grid-cols-2 gap-10 text-sm">
          <div className="border-t border-gray-500 pt-2">{c.issuedByName || "Authorised officer"}<br /><span className="text-gray-500">For {INSTITUTE}</span></div>
          <div className="border-t border-gray-500 pt-2">{longDate(c.issuedAt)}<br /><span className="text-gray-500">Date of issue</span></div>
        </div>
        {footer}
      </section>
      {cert ? (
        <section className={page + " break-before-page text-left"}>
          <p className="text-center text-sm uppercase tracking-[0.3em] text-gray-600">{INSTITUTE}</p>
          <h2 className="mt-3 text-center font-serif text-2xl font-bold text-gray-900">Record of Results</h2>
          <p className="mt-6 text-sm"><strong>Student:</strong> {c.studentName}<br /><strong>Qualification:</strong> {c.courseCode} {c.courseName}</p>
          {results}
          <p className="mt-4 text-xs text-gray-600">This record of results must be read with certificate No. {c.certificateNo}.</p>
          {footer}
        </section>
      ) : null}
    </div>
  );
}
