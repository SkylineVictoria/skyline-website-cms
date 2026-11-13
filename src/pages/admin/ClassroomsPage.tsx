import { useCallback, useEffect, useState } from "react";
import { Button, Card, EmptyState, PageHeader, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { ErrorNote, ReadOnlyNote } from "@/pages/admin/components/rto/shared";
import { rto, type Classroom } from "@/pages/admin/lib/rto";

type Row = { id?: string; name: string; campus: string; capacity: string; isActive: boolean };
const toRow = (c: Classroom): Row => ({ id: c.id, name: c.name, campus: c.campus ?? "", capacity: c.capacity ? String(c.capacity) : "", isActive: c.isActive });

/** Master Data › Classrooms: the rooms batches are taught in. RTO Managers edit; Admins view. */
export default function ClassroomsPage() {
  const { push } = useToast();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saved, setSaved] = useState<Row[]>([]);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, me] = await Promise.all([rto<Classroom[]>("classroom_list"), rto<{ rtoManager: boolean }>("me")]);
      const r = list.map(toRow); setRows(r); setSaved(r); setCanEdit(me.rtoManager); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Classrooms did not load."); setRows([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (i: number, patch: Partial<Row>) => setRows((list) => (list ?? []).map((r, x) => (x === i ? { ...r, ...patch } : r)));
  const save = async (i: number) => {
    const r = rows?.[i]; if (!r) return;
    setBusy(i);
    try {
      const list = await rto<Classroom[]>("classroom_save", { id: r.id ?? null, name: r.name, campus: r.campus, capacity: r.capacity, isActive: r.isActive });
      const next = list.map(toRow); setRows(next); setSaved(next); push(`${r.name.trim()} saved.`);
    } catch (e) { push(e instanceof Error ? e.message : "Not saved.", "error"); }
    finally { setBusy(null); }
  };
  const changed = (i: number) => { const r = rows?.[i]; return !r?.id || JSON.stringify(r) !== JSON.stringify(saved.find((s) => s.id === r.id)); };

  return (
    <div>
      <PageHeader title="Classrooms" description="The rooms batches are taught in. A batch picks its classroom in Intakes › an intake › Batches."
        actions={canEdit ? <Button icon="ri-add-line" onClick={() => setRows((list) => [...(list ?? []), { name: "", campus: "", capacity: "", isActive: true }])}>Add classroom</Button> : null} />
      <ErrorNote text={error} />
      {!canEdit && rows ? <div className="mb-3"><ReadOnlyNote>Only an RTO Manager can add or change classrooms.</ReadOnlyNote></div> : null}
      {rows === null ? <p className="py-10 text-center text-foreground-500">Loading classrooms…</p> : rows.length === 0 ? (
        <Card><EmptyState icon="ri-building-line" title="No classrooms yet" description={canEdit ? "Add the first classroom: a name, its campus and how many students it seats." : "An RTO Manager adds classrooms."} /></Card>
      ) : (
        <Card className="divide-y divide-background-200">
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_5rem_6rem] gap-2 px-4 py-2 text-xs font-medium text-foreground-500 md:grid">
            <span>Name</span><span>Campus</span><span>Capacity</span><span>Active</span><span />
          </div>
          {rows.map((r, i) => (
            <div key={r.id ?? `new-${i}`} className={`grid grid-cols-1 items-center gap-2 px-4 py-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_7rem_5rem_6rem] ${r.isActive ? "" : "opacity-60"}`}>
              <TextInput disabled={!canEdit} value={r.name} placeholder="e.g. Room 2.04" aria-label="Classroom name" onChange={(e) => set(i, { name: e.target.value })} />
              <TextInput disabled={!canEdit} value={r.campus} placeholder="Campus" aria-label="Campus" onChange={(e) => set(i, { campus: e.target.value })} />
              <TextInput disabled={!canEdit} value={r.capacity} inputMode="numeric" placeholder="Seats" aria-label="Capacity" onChange={(e) => set(i, { capacity: e.target.value.replace(/\D/g, "") })} />
              <Toggle disabled={!canEdit} checked={r.isActive} onChange={(v) => set(i, { isActive: v })} />
              {canEdit ? <Button size="sm" variant={changed(i) ? "primary" : "outline"} disabled={busy !== null || !r.name.trim() || !changed(i)} onClick={() => void save(i)}>{busy === i ? "Saving…" : "Save"}</Button> : <span />}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
