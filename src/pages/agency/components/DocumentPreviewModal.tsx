import { useEffect } from "react";

/**
 * A document shown on the page (owner 2026-11-26: Preview opened a new tab): PDFs in a frame, pictures as an image, anything else
 * with a Download button. The link is a short-lived signed URL; nothing is stored.
 */
export default function DocumentPreviewModal({ url, filename, onClose, onDownload }: {
  url: string;
  filename: string;
  onClose: () => void;
  onDownload: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const lower = filename.toLowerCase();
  const isPdf = lower.endsWith(".pdf");
  const isImage = /\.(png|jpe?g|gif|webp|bmp)$/.test(lower);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-foreground-950/60 p-3 sm:p-6" onClick={onClose} data-testid="document-preview">
      <div role="dialog" aria-modal="true" aria-label={`Preview of ${filename}`} onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-card bg-background-50 shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-background-200 px-4 py-3">
          <p className="min-w-0 truncate text-sm font-semibold text-foreground-950">{filename}</p>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={onDownload} className="rounded border border-background-300 px-3 py-1.5 text-xs font-semibold text-foreground-700 hover:bg-background-100">Download</button>
            <button type="button" onClick={onClose} aria-label="Close preview" className="rounded p-1.5 text-foreground-600 hover:bg-background-100"><i className="ri-close-line text-lg" aria-hidden="true" /></button>
          </div>
        </div>
        <div className="min-h-0 flex-1 bg-background-100">
          {isPdf ? <iframe src={url} title={filename} className="h-full w-full border-0" />
            : isImage ? <div className="flex h-full items-center justify-center overflow-auto p-4"><img src={url} alt={filename} className="max-h-full max-w-full object-contain" /></div>
            : <div className="flex h-full items-center justify-center p-6 text-center text-sm text-foreground-700">This file type cannot be shown here. Use Download to open it.</div>}
        </div>
      </div>
    </div>
  );
}
