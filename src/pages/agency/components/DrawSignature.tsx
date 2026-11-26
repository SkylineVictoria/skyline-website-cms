import SignaturePad from "@/components/signing/SignaturePad";

/**
 * APPLICATION-DRAWN-SIGNATURE (owner 2026-11-26): the student draws their signature to sign the application. onChange gets a PNG
 * data URL (data:image/png;base64,…) or null when cleared. The same pad as the signing page and the staff offer letter.
 */
export default function DrawSignature({ onChange, error }: { onChange: (png: string | null) => void; error?: string }) {
  return (
    <div data-testid="application-signature">
      <p className="mb-1.5 text-sm font-semibold text-foreground-900">Your signature <span className="text-primary-600">*</span></p>
      <p className="mb-2 text-xs text-foreground-600">Draw your signature in the box with your finger, mouse or pen.</p>
      <SignaturePad onChange={(b64) => onChange(b64 ? `data:image/png;base64,${b64}` : null)} />
      {error ? <p role="alert" className="mt-1 text-xs text-primary-700">{error}</p> : null}
    </div>
  );
}
