import { useCallback, useEffect, useState } from "react";
import { Button, Card, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { supabase } from "@/pages/admin/lib/supabase";
import { useAuth } from "@/pages/admin/lib/authContext";

interface Row { id?: string; label: string; amount: string; isActive: boolean }
const toRow = (r: { id: string; label: string; amount_cents: number | null; is_active: boolean }): Row =>
  ({ id: r.id, label: r.label, amount: r.amount_cents === null ? "" : (r.amount_cents / 100).toFixed(2), isActive: r.is_active });
const cents = (amount: string): number | null | undefined => {
  const clean = amount.replace(/[$,\s]/g, "");
  if (clean === "") return null; // blank prints "Free"
  return /^\d+(\.\d{1,2})?$/.test(clean) ? Math.round(Number(clean) * 100) : undefined;
};

/** Settings › Other fees and charges: the table on page 5 of the offer letter ({{#each other_fees}}). Admins edit; order = print order. */
export default function OtherFeesSettings() {
  const { push } = useToast();
  const { can } = useAuth();
  const readOnly = !can("governance");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("letter_other_fees").select("id,label,amount_cents,is_active,sort").is("tenant_id", null).order("sort");
    if (e) { setError(e.message); setRows([]); return; }
    const list = (data ?? []).map(toRow); setRows(list); setSaved(JSON.stringify(list)); setError("");
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (i: number, patch: Partial<Row>) => setRows((list) => (list ?? []).map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const move = (i: number, dir: -1 | 1) => setRows((list) => {
    const next = [...(list ?? [])]; const to = i + dir;
    if (to < 0 || to >= next.length) return next;
    [next[i], next[to]] = [next[to], next[i]]; return next;
  });
  const invalid = (rows ?? []).some((r) => !r.label.trim() || cents(r.amount) === undefined);
  const save = async () => {
    if (!rows) return;
    setBusy(true);
    const { data, error: e } = await supabase.rpc("letter_other_fees_save", { p_items: rows.map((r) => ({ id: r.id ?? null, label: r.label.trim(), amountCents: cents(r.amount), isActive: r.isActive })) });
    setBusy(false);
    if (e) { push(e.message, "error"); return; }
    const list = ((data ?? []) as Array<{ id: string; label: string; amountCents: number | null; isActive: boolean }>).map((r) => toRow({ id: r.id, label: r.label, amount_cents: r.amountCents, is_active: r.isActive }));
    setRows(list); setSaved(JSON.stringify(list)); push("Other fees and charges saved. New offer letters print them.");
  };

  return (
    <Card className="p-5">
      <h2 className="font-heading text-base font-semibold text-foreground-950">Other fees and charges</h2>
      <p className="mt-1 text-sm text-foreground-500">The table on the offer letter’s “Other fees and charges” page, in this order. Leave the amount blank to print “Free”.</p>
      {error ? <p role="alert" className="mt-3 text-sm text-primary-700">{error}</p> : null}
      {rows === null ? <p className="mt-3 text-sm text-foreground-500">Loading…</p> : (
        <div className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <div key={r.id ?? `new-${i}`} className={`grid grid-cols-[2rem_minmax(0,1fr)_7rem_auto_auto] items-center gap-2 ${r.isActive ? "" : "opacity-60"}`}>
              <div className="flex flex-col">
                <button type="button" aria-label="Move up" disabled={readOnly || i === 0} onClick={() => move(i, -1)} className="text-foreground-400 hover:text-primary-600 disabled:opacity-30"><i className="ri-arrow-up-s-fill" aria-hidden="true" /></button>
                <button type="button" aria-label="Move down" disabled={readOnly || i === rows.length - 1} onClick={() => move(i, 1)} className="text-foreground-400 hover:text-primary-600 disabled:opacity-30"><i className="ri-arrow-down-s-fill" aria-hidden="true" /></button>
              </div>
              <TextInput disabled={readOnly} value={r.label} aria-label="Fee name" onChange={(e) => set(i, { label: e.target.value })} />
              <TextInput disabled={readOnly} value={r.amount} placeholder="Free" inputMode="decimal" aria-label="Amount (AUD)"
                className={`text-right tabular-nums ${cents(r.amount) === undefined ? "border-primary-500" : ""}`} onChange={(e) => set(i, { amount: e.target.value })} />
              <Toggle disabled={readOnly} checked={r.isActive} onChange={(v) => set(i, { isActive: v })} />
              {readOnly ? <span /> : <Button variant="ghost" size="sm" icon="ri-delete-bin-line" aria-label="Remove" onClick={() => setRows((list) => (list ?? []).filter((_, x) => x !== i))} />}
            </div>
          ))}
          {readOnly ? null : (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
              <Button variant="outline" size="sm" icon="ri-add-line" onClick={() => setRows((list) => [...(list ?? []), { label: "", amount: "", isActive: true }])}>Add fee</Button>
              <Button disabled={busy || invalid || JSON.stringify(rows) === saved} onClick={() => void save()}>{busy ? "Saving…" : "Save other fees"}</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
