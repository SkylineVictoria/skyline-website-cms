import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import { usePortalAuth } from "../lib/portalAuthContext";
import { PortalError } from "./PortalUI";
interface Message { id: string; body: string; visibility: string; author_name: string; created_at: string }
export default function ApplicationMessages({ applicationId }: { applicationId: string }) {
  const { authUser, profile, role } = usePortalAuth();
  const [items, setItems] = useState<Message[]>([]);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("enrollment_application_messages").select("id,body,visibility,author_name,created_at").eq("application_id", applicationId).order("created_at", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    setItems(data ?? []);
  }, [applicationId]);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  async function send() {
    if (!body.trim() || !authUser) return;
    setBusy(true); setError("");
    try {
      const { error } = await supabase.from("enrollment_application_messages").insert({ application_id: applicationId, body: body.trim(), visibility: internal && role === "slit_admin" ? "internal" : "agency", author: authUser.id, author_name: profile?.fullName || authUser.email });
      if (error) throw new Error(error.message);
      setBody(""); await load();
    } catch (e) { setError(e instanceof Error ? e.message : "Message could not be saved."); }
    finally { setBusy(false); }
  }
  return <section className="space-y-4 rounded border bg-background-50 p-5"><h2 className="font-semibold">Application messages</h2>
    {error ? <PortalError message={error} /> : null}
    <label className="block">Message<textarea aria-label="Message" maxLength={8000} className="mt-2 block w-full rounded border p-3" value={body} onChange={e => setBody(e.target.value)} /></label>
    {role === "slit_admin" ? <label className="flex gap-2"><input type="checkbox" checked={internal} onChange={e => setInternal(e.target.checked)} />Internal reviewer note</label> : null}
    <button className="rounded border px-4 py-2" disabled={busy || !body.trim()} onClick={() => void send()}>Send message</button>
    <ul className="divide-y">{items.map(item => <li key={item.id} className="py-3"><p className="text-xs">{item.author_name} · {item.visibility === "internal" ? "Internal reviewer note" : "Agency message"} · {new Date(item.created_at).toLocaleString()}</p><p className="whitespace-pre-wrap">{item.body}</p></li>)}</ul>
  </section>;
}
