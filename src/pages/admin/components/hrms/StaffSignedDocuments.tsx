import { useRef, useState } from "react";
import { Badge, Button, Card, Field, TextInput } from "@/pages/admin/components/ui";
import SubjectSigningPanel from "@/pages/admin/components/signing/SubjectSigningPanel";
import { adminRemoveStaffSigned, adminUploadStaffSigned, staffSignedUrl, type StaffSigning } from "@/lib/staffApi";

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.doc,.docx";

/**
 * STAFF-SIGN: documents the person must sign before they are activated. Send them through Skyline Sign (the panel below), or
 * upload copies signed on paper. Activation is offered once something is signed and nothing sent for signature is waiting.
 */
export default function StaffSignedDocuments({ profileId, name, signing, onChanged }: {
  profileId: string;
  name: string;
  signing: StaffSigning | null;
  onChanged: () => Promise<unknown>;
}) {
  const [title, setTitle] = useState("Employment contract");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const ready = signing !== null && signing.problem === null;

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true); setError("");
    try { await adminUploadStaffSigned(profileId, title.trim(), f); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "The file could not be uploaded."); }
    finally { setBusy(false); if (file.current) file.current.value = ""; }
  };
  const remove = async (id: string, label: string) => {
    if (!window.confirm(`Remove ${label}?`)) return;
    setBusy(true); setError("");
    try { await adminRemoveStaffSigned(id); await onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "The document could not be removed."); }
    finally { setBusy(false); }
  };
  const open = async (path: string) => {
    try { window.open(await staffSignedUrl(path), "_blank", "noopener"); } catch (e) { setError(e instanceof Error ? e.message : "The document could not be opened."); }
  };

  return (
    <div className="mt-6 space-y-4" data-testid="staff-signed-documents">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="font-heading text-base font-bold text-foreground-950">Signed documents</h2>
            <p className="text-sm text-foreground-600">Before activation: send documents for e-signature below, or upload copies signed on paper.</p>
          </div>
          {signing ? <Badge tone={ready ? "success" : "warn"}>{ready ? "Ready to activate" : "Not ready"}</Badge> : null}
        </div>
        {signing?.problem ? <p className="mt-2 text-sm text-amber-800" data-testid="staff-signing-problem">{signing.problem}</p> : null}
        {error ? <p role="alert" className="mt-2 text-sm text-red-700">{error}</p> : null}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Document"><TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="Employment contract" /></Field>
          <Button variant="outline" icon="ri-upload-2-line" disabled={busy || !title.trim()} onClick={() => file.current?.click()}>{busy ? "Uploading…" : "Upload signed copy"}</Button>
          <input ref={file} type="file" accept={ACCEPT} className="hidden" aria-label="Signed document file" onChange={(e) => void upload(e.target.files?.[0])} />
        </div>
        {signing && signing.uploads.length ? (
          <ul className="mt-3 divide-y divide-background-200 text-sm">
            {signing.uploads.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <button type="button" className="text-left font-medium text-primary-700 hover:underline" onClick={() => void open(u.path)}>
                  <i className="ri-file-text-line mr-1" aria-hidden="true" />{u.title} <span className="font-normal text-foreground-500">({u.fileName})</span>
                </button>
                <span className="flex items-center gap-3 text-xs text-foreground-500">
                  Uploaded {new Date(u.createdAt).toLocaleDateString()}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void remove(u.id, u.title)}>Remove</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : signing ? <p className="mt-3 text-sm text-foreground-600">No signed copy uploaded.</p> : null}
      </Card>
      <SubjectSigningPanel type="employee" id={profileId} name={name} />
    </div>
  );
}
