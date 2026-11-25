import { useEffect, useState } from "react";
import { Button, Modal } from "@/pages/admin/components/ui";

/** What to show: a URL (signed storage link or blob URL) with its file name; `revoke` frees a blob URL when the viewer closes. */
export interface ViewerDoc { url: string; name: string; revoke?: boolean }

const kindOf = (name: string) => /\.pdf$/i.test(name) ? "pdf" : /\.(png|jpe?g|gif|webp)$/i.test(name) ? "image" : "other";

/**
 * Shows a document in place (owner 2026-11-24: "allow to view doc in place of downloading in another tab"): PDFs in the browser's
 * own viewer inside the dialog, pictures as they are; Word files cannot be shown by the browser, so they offer Download only.
 */
export default function DocumentViewer({ doc, onClose }: { doc: ViewerDoc | null; onClose: () => void }) {
  const [shown, setShown] = useState<ViewerDoc | null>(doc);
  useEffect(() => { setShown(doc); }, [doc]);
  useEffect(() => () => { if (shown?.revoke) setTimeout(() => URL.revokeObjectURL(shown.url), 1000); }, [shown]);
  if (!shown) return null;
  const kind = kindOf(shown.name);
  const download = () => {
    const a = document.createElement("a");
    a.href = shown.url; a.download = shown.name; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  };
  return (
    <Modal open fill title={shown.name} width="max-w-5xl" onClose={onClose}
      footer={<div className="flex justify-end gap-2"><Button variant="outline" icon="ri-download-2-line" onClick={download}>Download</Button><Button onClick={onClose}>Close</Button></div>}>
      <div className="h-[75vh] w-full overflow-auto rounded-md bg-background-100" data-testid="document-viewer">
        {kind === "pdf" ? <iframe title={shown.name} src={shown.url} className="h-full w-full border-0" />
          : kind === "image" ? <img src={shown.url} alt={shown.name} className="mx-auto max-h-full max-w-full object-contain" />
          : <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-foreground-600">
              <i className="ri-file-word-line text-4xl" aria-hidden="true" />
              <p>This file type cannot be shown in the browser.</p>
              <Button icon="ri-download-2-line" onClick={download}>Download {shown.name}</Button>
            </div>}
      </div>
    </Modal>
  );
}
