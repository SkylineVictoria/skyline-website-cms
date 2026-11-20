import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

type Kind = "text" | "link" | "video" | "file";
interface Item { id: string; kind: Kind; title: string; body: string; url: string | null; storage_path: string | null; file_name: string | null; size_bytes: number | null; sort: number; visible_to_students: boolean; updated_at: string }
const KINDS: { id: Kind; label: string; icon: string }[] = [
  { id: "text", label: "Notes", icon: "ri-file-text-line" }, { id: "file", label: "File", icon: "ri-attachment-2" },
  { id: "link", label: "Web link", icon: "ri-links-line" }, { id: "video", label: "Video link", icon: "ri-video-line" },
];
const ICON: Record<Kind, string> = Object.fromEntries(KINDS.map(k => [k.id, k.icon])) as Record<Kind, string>;
const ACCEPT = ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.txt";
const input = "w-full rounded-lg border border-background-300 bg-background-50 px-3 py-2 text-sm";
const safeName = (name: string) => name.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(-120) || "file";
const size = (n: number | null) => n == null ? "" : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** LMS > Courses > Units > a unit > Learning content: notes, files, links and videos for the unit, in order. RTO Managers edit. */
export default function UnitContentPanel({ unitId, canEdit }: { unitId: string; canEdit: boolean }) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("text");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [visible, setVisible] = useState(true);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("unit_contents").select("id,kind,title,body,url,storage_path,file_name,size_bytes,sort,visible_to_students,updated_at")
      .eq("unit_id", unitId).order("sort").order("created_at");
    setLoading(false);
    if (error) { setError(error.message); return; }
    setItems((data ?? []) as Item[]);
  }, [unitId]);
  useEffect(() => { void load(); }, [load]);

  const reset = () => { setAdding(false); setEditing(null); setKind("text"); setTitle(""); setBody(""); setUrl(""); setFile(null); setVisible(true); };
  const run = async (job: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await job(); await load(); } catch (e) { setError(e instanceof Error ? e.message : "That did not work. Try again."); } finally { setBusy(false); }
  };

  const save = () => run(async () => {
    if (!title.trim()) throw new Error("Give the item a title.");
    if ((kind === "link" || kind === "video") && !/^https:\/\//i.test(url.trim())) throw new Error("Enter a full web address starting with https://");
    if (editing) {
      const { error } = await supabase.from("unit_contents").update({ title: title.trim(), body, url: kind === "link" || kind === "video" ? url.trim() : null, visible_to_students: visible }).eq("id", editing);
      if (error) throw new Error(error.message);
      reset(); return;
    }
    let path: string | null = null;
    if (kind === "file") {
      if (!file) throw new Error("Choose a file.");
      const filename = safeName(file.name);
      const extension = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? null;
      const limit = await supabase.rpc("unit_learning_file_limit", { p_unit_id: unitId, p_extension: extension });
      if (limit.error || typeof limit.data !== "number") throw new Error("The learning file limit could not be verified. Try again or ask an administrator to review the rule.");
      if (file.size > limit.data) throw new Error(`The learning file exceeds the current limit of ${size(limit.data)}.`);
      path = `${unitId}/${crypto.randomUUID().slice(0, 8)}-${filename}`;
      const up = await supabase.storage.from("unit-content").upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (up.error) throw new Error(`The file could not be uploaded: ${up.error.message}`);
    }
    const next = items.length ? Math.max(...items.map(i => i.sort)) + 1 : 0;
    const { error } = await supabase.from("unit_contents").insert({
      unit_id: unitId, kind, title: title.trim(), body, url: kind === "link" || kind === "video" ? url.trim() : null,
      storage_path: path, file_name: file?.name ?? null, mime_type: file?.type || null, size_bytes: file?.size ?? null, sort: next, visible_to_students: visible,
    });
    if (error) { if (path) await supabase.storage.from("unit-content").remove([path]); throw new Error(error.message); }
    reset();
  });
  const remove = (it: Item) => {
    if (!window.confirm(`Remove "${it.title}"?`)) return;
    void run(async () => {
      const { error } = await supabase.from("unit_contents").delete().eq("id", it.id);
      if (error) throw new Error(error.message);
      if (it.storage_path) await supabase.storage.from("unit-content").remove([it.storage_path]);
    });
  };
  const move = (index: number, delta: number) => {
    const a = items[index], b = items[index + delta];
    if (!a || !b) return;
    void run(async () => {
      const r1 = await supabase.from("unit_contents").update({ sort: b.sort === a.sort ? a.sort + delta : b.sort }).eq("id", a.id);
      const r2 = await supabase.from("unit_contents").update({ sort: a.sort }).eq("id", b.id);
      if (r1.error || r2.error) throw new Error((r1.error ?? r2.error)!.message);
    });
  };
  const toggle = (it: Item) => void run(async () => {
    const { error } = await supabase.from("unit_contents").update({ visible_to_students: !it.visible_to_students }).eq("id", it.id);
    if (error) throw new Error(error.message);
  });
  const open = async (it: Item) => {
    if (it.url) { window.open(it.url, "_blank", "noopener"); return; }
    if (!it.storage_path) return;
    const { data, error } = await supabase.storage.from("unit-content").createSignedUrl(it.storage_path, 300);
    if (error || !data?.signedUrl) { setError("The file could not be opened."); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  };
  const startEdit = (it: Item) => { setAdding(true); setEditing(it.id); setKind(it.kind); setTitle(it.title); setBody(it.body); setUrl(it.url ?? ""); setFile(null); setVisible(it.visible_to_students); };

  return (
    <div className="space-y-4" data-testid="unit-content">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-foreground-600">Notes, files, web links and videos for this unit, in the order students should use them.</p>
        {canEdit && !adding ? <button type="button" onClick={() => { reset(); setAdding(true); }} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white hover:bg-primary-700">+ Add content</button> : null}
      </div>
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}

      {adding ? (
        <div className="space-y-3 rounded-xl border border-background-200 bg-background-100/50 p-4">
          {!editing ? <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Type of content">
            {KINDS.map(k => <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} onClick={() => setKind(k.id)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${kind === k.id ? "bg-primary-500 text-white" : "border border-background-300 text-foreground-700"}`}>
              <i className={`${k.icon} mr-1`} aria-hidden="true" />{k.label}</button>)}
          </div> : null}
          <label className="block text-xs font-medium text-foreground-500">Title<input className={input + " mt-1"} value={title} onChange={e => setTitle(e.target.value)} maxLength={200} placeholder="e.g. Week 1: Introduction" /></label>
          {kind === "link" || kind === "video" ? <label className="block text-xs font-medium text-foreground-500">{kind === "video" ? "Video address (YouTube, Vimeo, Stream…)" : "Web address"}
            <input className={input + " mt-1"} type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://" /></label> : null}
          {kind === "file" && !editing ? <label className="block text-xs font-medium text-foreground-500">File (PDF, Word, PowerPoint, Excel, image)
            <input className={input + " mt-1"} type="file" accept={ACCEPT} onChange={e => setFile(e.currentTarget.files?.[0] ?? null)} /></label> : null}
          <label className="block text-xs font-medium text-foreground-500">{kind === "text" ? "Notes" : "Description (optional)"}
            <textarea className={input + " mt-1"} rows={kind === "text" ? 8 : 3} value={body} onChange={e => setBody(e.target.value)} maxLength={20000} /></label>
          <label className="flex items-center gap-2 text-sm text-foreground-800"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} />Show to students</label>
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-primary-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Saving…" : editing ? "Save changes" : "Add"}</button>
            <button type="button" onClick={reset} className="rounded-lg border border-background-300 px-3 py-2 text-sm font-semibold">Cancel</button>
          </div>
        </div>
      ) : null}

      {loading ? <p className="text-sm text-foreground-500" role="status">Loading content…</p>
        : items.length === 0 ? <p className="rounded-xl border border-dashed border-background-300 p-6 text-center text-sm text-foreground-500">No learning content yet.{canEdit ? " Use + Add content." : ""}</p>
        : <ol className="space-y-2">{items.map((it, i) => (
          <li key={it.id} className="rounded-xl border border-background-200 bg-background-50 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button type="button" onClick={() => void open(it)} disabled={it.kind === "text"} className="min-w-0 text-left disabled:cursor-default">
                <span className="flex items-center gap-2 font-semibold text-foreground-950"><i className={`${ICON[it.kind]} text-primary-600`} aria-hidden="true" />{i + 1}. {it.title}</span>
                <span className="block truncate text-xs text-foreground-500">{it.kind === "file" ? `${it.file_name ?? "File"} · ${size(it.size_bytes)}` : it.url ?? ""}{it.visible_to_students ? "" : " · hidden from students"}</span>
              </button>
              {canEdit ? <div className="flex shrink-0 items-center gap-1 text-foreground-600">
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} aria-label="Move up" className="rounded p-1 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-up-line" aria-hidden="true" /></button>
                <button type="button" disabled={busy || i === items.length - 1} onClick={() => move(i, 1)} aria-label="Move down" className="rounded p-1 hover:bg-background-100 disabled:opacity-30"><i className="ri-arrow-down-line" aria-hidden="true" /></button>
                <button type="button" disabled={busy} onClick={() => toggle(it)} aria-label={it.visible_to_students ? "Hide from students" : "Show to students"} title={it.visible_to_students ? "Shown to students" : "Hidden from students"} className="rounded p-1 hover:bg-background-100"><i className={it.visible_to_students ? "ri-eye-line" : "ri-eye-off-line"} aria-hidden="true" /></button>
                <button type="button" disabled={busy} onClick={() => startEdit(it)} aria-label="Edit" className="rounded p-1 hover:bg-background-100"><i className="ri-pencil-line" aria-hidden="true" /></button>
                <button type="button" disabled={busy} onClick={() => remove(it)} aria-label="Remove" className="rounded p-1 text-red-700 hover:bg-red-50"><i className="ri-delete-bin-line" aria-hidden="true" /></button>
              </div> : null}
            </div>
            {it.body ? <p className={`mt-2 whitespace-pre-wrap text-sm text-foreground-700 ${it.kind === "text" ? "" : "line-clamp-2"}`}>{it.body}</p> : null}
          </li>))}</ol>}
    </div>
  );
}
