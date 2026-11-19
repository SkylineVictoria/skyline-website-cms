// Communication Hub › Groups: every intake's group (INTAKE-GROUPS). Opening one shows its Group panel.
import { useEffect, useMemo, useState } from "react";
import { Badge, Select, TextInput } from "@/pages/admin/components/ui";
import IntakeGroupPanel from "@/pages/admin/components/rto/IntakeGroupPanel";
import { intakeGroup, type GroupRow } from "@/pages/admin/lib/intakeGroups";

const date = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export default function IntakeGroupsList() {
  const [rows, setRows] = useState<GroupRow[] | null>(null);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [course, setCourse] = useState("");
  const [status, setStatus] = useState<"active" | "closed" | "">("active");
  const [notOnWhatsapp, setNotOnWhatsapp] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const load = () => intakeGroup<GroupRow[]>("list").then((r) => { setRows(r); setError(""); }).catch((e) => setError(e instanceof Error ? e.message : "Groups did not load."));
  useEffect(() => { void load(); }, []);

  const courses = useMemo(() => [...new Map((rows ?? []).map((r) => [r.courseId, r.courseName])).entries()], [rows]);
  const shown = (rows ?? []).filter((r) => (!status || r.status === status) && (!course || r.courseId === course)
    && (!notOnWhatsapp || r.whatsappJoined < r.students + r.trainers)
    && (!q || `${r.title} ${r.courseName} ${r.m365Address ?? ""}`.toLowerCase().includes(q.toLowerCase())));

  if (error) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!rows) return <p role="status" className="text-sm text-foreground-600">Loading groups…</p>;
  const selected = open ? rows.find((r) => r.intakeId === open) : null;

  return (
    <section className="space-y-3">
      <p className="text-sm text-foreground-600">Every intake has one group: a Microsoft 365 email group, a WhatsApp group and a text list. Students join and leave with the intake.</p>
      <div className="grid items-center gap-2 sm:grid-cols-[2fr_1fr_1fr_auto]">
        <TextInput type="search" placeholder="Search groups" aria-label="Search groups" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select value={course} onChange={(e) => setCourse(e.target.value)} aria-label="Course"><option value="">All courses</option>{courses.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select>
        <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status"><option value="active">Active</option><option value="closed">Closed</option><option value="">All</option></Select>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={notOnWhatsapp} onChange={(e) => setNotOnWhatsapp(e.target.checked)} />Members not on WhatsApp</label>
      </div>
      <div className="overflow-x-auto rounded-xl border border-background-200 bg-background-50">
        <table className="w-full text-sm">
          <thead className="bg-background-100 text-left text-xs text-foreground-500"><tr>
            <th className="px-3 py-2">Group</th><th className="px-3">Members</th><th className="px-3">Email (Microsoft 365)</th><th className="px-3">WhatsApp</th><th className="px-3">Text</th><th className="px-3">Last message</th><th className="px-3">Status</th></tr></thead>
          <tbody className="divide-y divide-background-100">
            {shown.map((r) => {
              const total = r.students + r.trainers;
              return (
                <tr key={r.intakeId} onClick={() => setOpen(open === r.intakeId ? null : r.intakeId)} className={`cursor-pointer align-top hover:bg-background-100 ${open === r.intakeId ? "bg-primary-50" : ""}`}>
                  <td className="px-3 py-2.5"><button type="button" className="text-left font-semibold text-foreground-950 hover:underline">{r.title}</button><span className="block text-xs text-foreground-500">{r.courseName}</span></td>
                  <td className="px-3 py-2.5">{r.students} students<span className="block text-xs text-foreground-500">{r.trainers} trainer{r.trainers === 1 ? "" : "s"}</span></td>
                  <td className="px-3 py-2.5"><span className="break-all">{r.m365Address ?? (r.m365Status === "not_configured" ? "Not set up" : r.m365Status === "failed" ? "Failed" : "Being created")}</span>
                    <span className="block"><Badge tone={r.m365Members === total && total ? "success" : "muted"}>{r.m365Members} of {total}</Badge></span></td>
                  <td className="px-3 py-2.5">{r.whatsappLink ? <Badge tone={r.whatsappJoined === total && total ? "success" : "warn"}>{r.whatsappJoined} of {total} joined</Badge> : <span className="text-xs text-foreground-500">No link yet</span>}</td>
                  <td className="px-3 py-2.5"><Badge tone={r.textable === total && total ? "success" : "muted"}>{r.textable} of {total}</Badge></td>
                  <td className="px-3 py-2.5">{r.lastMessage ? <>{date(r.lastMessage.at)}<span className="block text-xs text-foreground-500">{r.lastMessage.by}: {r.lastMessage.text}</span></> : <span className="text-xs text-foreground-500">No messages yet</span>}</td>
                  <td className="px-3 py-2.5"><Badge tone={r.status === "active" ? "success" : "muted"}>{r.status === "active" ? "Active" : "Closed"}</Badge></td>
                </tr>
              );
            })}
            {!shown.length ? <tr><td colSpan={7} className="px-3 py-4 text-foreground-500">No groups match.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {selected ? <div className="rounded-xl border border-primary-200 p-4">
        <div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-heading text-lg font-semibold">{selected.title}</h2>
          <button type="button" aria-label="Close group details" onClick={() => { setOpen(null); void load(); }} className="rounded-md p-1 text-foreground-500 hover:bg-background-200"><i className="ri-close-line text-xl" aria-hidden="true" /></button></div>
        <IntakeGroupPanel key={selected.intakeId} intakeId={selected.intakeId} />
      </div> : null}
    </section>
  );
}
