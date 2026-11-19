// The intake's communication group (INTAKE-GROUPS): Microsoft 365 email group, WhatsApp group link and text list. Students join
// and leave with the intake; Admins / RTO Managers manage trainers and settings; the group's trainers may also send.
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Select, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import { rto, type StaffOption } from "@/pages/admin/lib/rto";
import { intakeGroup, syncMicrosoftGroup, type GroupDetail, type GroupMember } from "@/pages/admin/lib/intakeGroups";

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const key = (m: GroupMember) => `${m.kind}:${m.id}`;
const M365_TEXT: Record<GroupMember["m365Status"], string> = { member: "In group", pending: "Adding…", no_account: "No SLIT email yet", removed: "Removed", failed: "Failed" };

export default function IntakeGroupPanel({ intakeId }: { intakeId: string }) {
  const { push } = useToast();
  const [g, setG] = useState<GroupDetail | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [addStaff, setAddStaff] = useState("");
  const [channels, setChannels] = useState<{ email: boolean; sms: boolean }>({ email: true, sms: false });
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [link, setLink] = useState("");

  const show = (d: GroupDetail) => { setG(d); setLink(d.whatsappLink ?? ""); setError(""); };
  const load = useCallback(() => intakeGroup<GroupDetail>("get", { intakeId }).then(show).catch((e) => setError(e instanceof Error ? e.message : "The group did not load.")), [intakeId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (g?.canManage) void rto<StaffOption[]>("staff_list").then(setStaff).catch(() => undefined); }, [g?.canManage]);

  const act = async (action: string, data: Record<string, unknown>, done?: string) => {
    setBusy(true);
    try { show(await intakeGroup<GroupDetail>(action, { intakeId, ...data })); if (done) push(done); return true; }
    catch (e) { push(e instanceof Error ? e.message : "That did not work.", "error"); return false; }
    finally { setBusy(false); }
  };
  const sync = async () => {
    setBusy(true);
    try { const r = await syncMicrosoftGroup(intakeId); push(r.notConfigured ? "Microsoft 365 is not set up yet." : "Microsoft 365 group updated."); await load(); }
    catch (e) { push(e instanceof Error ? e.message : "Microsoft 365 sync failed.", "error"); await load(); }
    finally { setBusy(false); }
  };

  if (error) return <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>;
  if (!g) return <p role="status" className="text-sm text-foreground-600">Loading the group…</p>;

  const students = g.members.filter((m) => m.kind === "student");
  const notJoined = g.members.filter((m) => !m.whatsappJoined);
  const people = picked ? g.members.filter((m) => picked.has(key(m))) : g.members;
  const emails = channels.email ? people.filter((m) => m.email).length : 0;
  const texts = channels.sms ? people.filter((m) => m.phone && !m.smsOptOut).length : 0;
  const closed = g.status === "closed";
  const send = async () => {
    const ok = await act("send", { channels: [channels.email && "email", channels.sms && "sms"].filter(Boolean), subject, body,
      people: picked ? people.map((m) => ({ kind: m.kind, id: m.id })) : null }, "Message sent.");
    if (ok) { setBody(""); setSubject(""); setPicked(null); }
  };
  const card = "rounded-xl border border-background-200 bg-background-50 p-4";

  return (
    <div className="space-y-4">
      {closed ? <p role="status" className="rounded-lg border border-background-300 bg-background-100 p-3 text-sm">This group is closed. Nothing is sent and members are not added.</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className={card}>
          <p className="text-sm font-semibold"><i className="ri-mail-line" aria-hidden="true" /> Microsoft 365 email</p>
          <p className="mt-1 text-xl font-bold">{g.m365Members} of {g.members.length}</p>
          <p className="truncate text-xs text-foreground-600">{g.m365Address ?? (g.m365Status === "not_configured" ? "Microsoft 365 not set up yet" : g.m365Status === "failed" ? "Could not be created" : `${g.mailNickname}@… (being created)`)}</p>
          {g.m365Error ? <p className="mt-1 text-xs text-red-700">{g.m365Error}</p> : null}
          {g.canManage && !closed ? <Button size="sm" variant="outline" className="mt-2" disabled={busy} onClick={() => void sync()}>Sync now</Button> : null}
        </div>
        <div className={card}>
          <p className="text-sm font-semibold"><i className="ri-whatsapp-line" aria-hidden="true" /> WhatsApp group</p>
          <p className="mt-1 text-xl font-bold">{g.whatsappJoined} of {g.members.length} joined</p>
          <p className="text-xs text-foreground-600">{g.whatsappLink ? `${notJoined.length} not joined yet` : "Add the group's invite link below"}</p>
        </div>
        <div className={card}>
          <p className="text-sm font-semibold"><i className="ri-smartphone-line" aria-hidden="true" /> Text list</p>
          <p className="mt-1 text-xl font-bold">{g.textable} of {g.members.length}</p>
          <p className="text-xs text-foreground-600">{!g.smsConnected ? "Texts are off until ClickSend is connected (Integrations)" : !g.smsEnabled ? "Texts switched off for this group" : `${g.members.length - g.textable} without a mobile or opted out`}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-4">
          <section className={card}>
            <h3 className="font-semibold">Members <span className="text-sm font-normal text-foreground-500">· {students.length} student{students.length === 1 ? "" : "s"}, {g.members.length - students.length} trainer{g.members.length - students.length === 1 ? "" : "s"} · students join and leave with the intake</span></h3>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="text-left text-xs text-foreground-500">
                  {!closed ? <th className="py-1.5 pr-2"><span className="sr-only">Pick</span></th> : null}
                  <th className="py-1.5 pr-2">Name</th><th className="pr-2">Email group</th><th className="pr-2">WhatsApp</th><th className="pr-2">Text</th><th /></tr></thead>
                <tbody className="divide-y divide-background-100">
                  {g.members.map((m) => (
                    <tr key={key(m)}>
                      {!closed ? <td className="py-2 pr-2"><input type="checkbox" aria-label={`Send to ${m.name ?? ""}`} checked={!picked || picked.has(key(m))}
                        onChange={(e) => setPicked((p) => { const s = new Set(p ?? g.members.map(key)); if (e.target.checked) s.add(key(m)); else s.delete(key(m)); return s.size === g.members.length ? null : s; })} /></td> : null}
                      <td className="py-2 pr-2"><span className="font-medium">{m.name ?? "—"}</span>{m.kind === "staff" ? <span className="ml-1.5"><Badge tone="secondary">Trainer</Badge></span> : null}
                        <span className="block text-xs text-foreground-500">{m.email ?? "no email"}</span></td>
                      <td className="pr-2" title={m.m365Error ?? undefined}><span className={m.m365Status === "member" ? "text-green-700" : m.m365Status === "failed" ? "text-red-700" : "text-foreground-500"}>{M365_TEXT[m.m365Status]}</span></td>
                      <td className="pr-2">{g.canManage ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={m.whatsappJoined} disabled={busy}
                          onChange={(e) => void act("member", { kind: m.kind, id: m.id, whatsappJoined: e.target.checked })} />
                          <span className={m.whatsappJoined ? "text-green-700" : "text-amber-700"}>{m.whatsappJoined ? "Joined" : m.whatsappInvitedAt ? `Invited ${when(m.whatsappInvitedAt)}` : "Not invited"}</span></label>
                        : <span>{m.whatsappJoined ? "Joined" : m.whatsappInvitedAt ? "Invited" : "Not invited"}</span>}</td>
                      <td className="pr-2">{!m.phone ? <span className="text-foreground-500">No mobile</span> : g.canManage ? <label className="flex items-center gap-1.5"><input type="checkbox" checked={!m.smsOptOut} disabled={busy}
                          onChange={(e) => void act("member", { kind: m.kind, id: m.id, smsOptOut: !e.target.checked })} />{m.smsOptOut ? "Opted out" : "Yes"}</label> : m.smsOptOut ? "Opted out" : "Yes"}</td>
                      <td className="whitespace-nowrap text-right">
                        {g.canManage && !closed && g.whatsappLink && !m.whatsappJoined ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("invite", { people: [{ kind: m.kind, id: m.id }] }, "Invite sent.")}>Resend invite</Button> : null}
                        {g.canManage && m.kind === "staff" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act("trainer_remove", { staffId: m.id }, "Trainer removed.")}>Remove</Button> : null}
                      </td>
                    </tr>
                  ))}
                  {!g.members.length ? <tr><td colSpan={6} className="py-3 text-foreground-500">No members yet. Students are added when they are placed in the intake.</td></tr> : null}
                </tbody>
              </table>
            </div>
            {g.canManage && !closed ? <div className="mt-3 flex flex-wrap items-center gap-2">
              <Select className="w-auto min-w-[14rem]" value={addStaff} onChange={(e) => setAddStaff(e.target.value)} aria-label="Trainer to add">
                <option value="">Add a trainer…</option>
                {staff.filter((s) => !g.members.some((m) => m.kind === "staff" && m.id === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
              <Button size="sm" variant="outline" disabled={!addStaff || busy} onClick={() => void act("trainer_add", { staffId: addStaff }, "Trainer added.").then((ok) => { if (ok) setAddStaff(""); })}>Add trainer</Button>
            </div> : null}
          </section>

          <section className={card}>
            <h3 className="font-semibold">History</h3>
            {!g.history.length ? <p className="mt-2 text-sm text-foreground-500">Nothing sent yet.</p> : <ul className="mt-2 divide-y divide-background-100">
              {g.history.map((h) => (
                <li key={h.id} className="py-2 text-sm">
                  <p className="font-medium">{h.subject ?? h.body.slice(0, 80)}</p>
                  <p className="text-xs text-foreground-500">{h.by ?? "SLIT"} · {when(h.at)} · {h.kind === "invite" ? "Welcome / invite" : h.channels.map((c) => (c === "sms" ? "Text" : "Email")).join(" + ")}
                    {" · "}{h.emailSent} emailed{h.emailQueued - h.emailSent - h.emailFailed > 0 ? `, ${h.emailQueued - h.emailSent - h.emailFailed} sending` : ""}{h.emailFailed ? `, ${h.emailFailed} failed` : ""}
                    {h.smsQueued ? ` · ${h.smsQueued} texts sent` : ""}{h.smsNotConnected ? ` · ${h.smsNotConnected} texts not sent (ClickSend off)` : ""}{h.skipped ? ` · ${h.skipped} skipped` : ""}</p>
                </li>
              ))}
            </ul>}
          </section>
        </div>

        <div className="space-y-4">
          {!closed ? <section className={card}>
            <h3 className="font-semibold">Send to the group</h3>
            <div className="mt-2 flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={channels.email} onChange={(e) => setChannels({ ...channels, email: e.target.checked })} />Email</label>
              <label className="flex items-center gap-1.5"><input type="checkbox" checked={channels.sms} disabled={!g.smsConnected || !g.smsEnabled} onChange={(e) => setChannels({ ...channels, sms: e.target.checked })} />Text</label>
            </div>
            {channels.email ? <TextInput className="mt-2" placeholder={`Subject (default: ${g.title})`} value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} /> : null}
            <TextArea className="mt-2" rows={4} placeholder="Write the message" value={body} maxLength={4000} onChange={(e) => setBody(e.target.value)} />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-xs text-foreground-600">{picked ? `${people.length} picked · ` : ""}{emails} emails · {texts} texts</span>
              <Button size="sm" disabled={busy || !body.trim() || (!channels.email && !channels.sms) || !people.length} onClick={() => void send()}>Send</Button>
            </div>
            <p className="mt-2 text-xs text-foreground-500">Admins, RTO Managers and the group's trainers can send. Members see what is sent; replies go to everyone in the WhatsApp and Microsoft 365 groups.</p>
          </section> : null}

          <section className={card}>
            <h3 className="font-semibold">WhatsApp group</h3>
            <p className="mt-1 text-xs text-foreground-600">Create the group in WhatsApp on SLIT's phone, then paste its invite link here. New members get it by email and text when they are placed.</p>
            {g.canManage && !closed ? <div className="mt-2 flex gap-2">
              <TextInput placeholder="https://chat.whatsapp.com/…" value={link} onChange={(e) => setLink(e.target.value)} />
              <Button size="sm" variant="outline" disabled={busy || link.trim() === (g.whatsappLink ?? "")} onClick={() => void act("settings", { whatsappLink: link.trim() }, link.trim() ? "Link saved and sent to everyone not joined." : "Link removed.")}>Save</Button>
            </div> : g.whatsappLink ? <p className="mt-2 break-all rounded bg-background-100 p-2 font-mono text-xs">{g.whatsappLink}</p> : null}
            {g.whatsappLink ? <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void navigator.clipboard.writeText(g.whatsappLink ?? "").then(() => push("Link copied."))}>Copy link</Button>
              {g.canManage && !closed && notJoined.length ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("invite", {}, `Invite sent to ${notJoined.length}.`)}>Resend to not joined ({notJoined.length})</Button> : null}
            </div> : null}
          </section>

          {g.canManage ? <section className={card}>
            <h3 className="font-semibold">Settings</h3>
            <div className="mt-2 space-y-2 text-sm">
              <div className="flex items-center justify-between gap-2"><span>Text messages</span><Toggle checked={g.smsEnabled} disabled={busy} onChange={(v) => void act("settings", { smsEnabled: v })} /></div>
              <div className="flex items-center justify-between gap-2"><span>Welcome message and invite for new members</span><Toggle checked={g.welcomeEnabled} disabled={busy} onChange={(v) => void act("settings", { welcomeEnabled: v })} /></div>
            </div>
            <div className="mt-3">{closed
              ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void act("reopen", {}, "Group reopened.")}>Reopen group</Button>
              : <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm("Close this group? Nothing more is sent and members leave the Microsoft 365 group.")) void act("close", {}, "Group closed."); }}>Close group</Button>}
            </div>
          </section> : null}
        </div>
      </div>
    </div>
  );
}
