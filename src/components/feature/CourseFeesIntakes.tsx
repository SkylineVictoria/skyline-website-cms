import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

interface Facts {
  showFees: boolean; feeNote: string | null; totalCents: number | null; gstCents?: number | null;
  items: { type: string; label: string; amountCents: number; includedInTotal: boolean; refundable?: boolean }[] | null;
  intakes: { name: string; startDate: string; endDate: string | null }[];
}
const LABEL: Record<string, string> = { application: "Application fee", registration: "Registration fee", material: "Material fee", tuition: "Tuition fee", other: "Other fee" };
const aud = (cents: number) => `$${(cents / 100).toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** Course page: fees from the course's line items (when the course shows them) and its upcoming open intakes. */
export default function CourseFeesIntakes({ slug, tenantId }: { slug: string; tenantId: string | null }) {
  const [facts, setFacts] = useState<Facts | null>(null);
  useEffect(() => {
    let live = true;
    void supabase.rpc("public_course_facts", { p_slug: slug, p_tenant: tenantId }).then(({ data }) => { if (live) setFacts((data as Facts | null) ?? null); });
    return () => { live = false; };
  }, [slug, tenantId]);
  if (!facts) return null;
  const all = facts.showFees ? facts.items ?? [] : [];
  const items = all.filter((i) => i.includedInTotal);
  const deposit = all.filter((i) => i.type === "initial_deposit").reduce((s, i) => s + i.amountCents, 0);
  return (
    <div className="mt-6 space-y-6 border-t border-background-300 pt-6">
      {items.length && facts.totalCents ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Fees</h3>
          <ul className="mt-2 space-y-1 text-sm text-foreground-800">
            {items.map((i, n) => <li key={n} className="flex justify-between gap-3"><span>{(i.label || LABEL[i.type] || i.type).replace(/\s*\(non-refundable\)\s*$/i, "")}{i.refundable === false ? " (Non-Refundable)" : ""}</span><span className="tabular-nums">{aud(i.amountCents)}</span></li>)}
          </ul>
          <p className="mt-2 flex justify-between border-t border-background-300 pt-2 font-semibold text-ink"><span>Total</span><span className="tabular-nums">AUD {aud(facts.totalCents)}</span></p>
          {facts.gstCents ? <p className="mt-1 flex justify-between text-sm text-foreground-700"><span>GST included</span><span className="tabular-nums">{aud(facts.gstCents)}</span></p> : null}
          {deposit ? <p className="mt-1 flex justify-between text-sm text-foreground-700"><span>Initial deposit (part of total)</span><span className="tabular-nums">{aud(deposit)}</span></p> : null}
          {facts.feeNote ? <p className="mt-2 text-xs text-foreground-600">{facts.feeNote}</p> : null}
        </div>
      ) : null}
      {facts.intakes.length ? (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Upcoming intakes</h3>
          <ul className="mt-2 space-y-1 text-sm text-foreground-800">{facts.intakes.slice(0, 4).map((i) => <li key={i.startDate}>{day(i.startDate)}{i.endDate ? ` – ${day(i.endDate)}` : ""}</li>)}</ul>
        </div>
      ) : null}
    </div>
  );
}
