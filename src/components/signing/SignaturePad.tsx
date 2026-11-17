import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { SIGNATURE_H, SIGNATURE_W } from "@/components/signing/signatureImage";

/* The signature pad and picture converter of the signing page (/sign), shared with the CMS: an administrator draws the signature
 * printed on an agent agreement (2026-11-17). The PNG is 600 x 200, base64 without the data: prefix, the one format the server accepts. */
/** A pad to draw a signature with a finger, a pen or the mouse. Reports the PNG after every stroke, or null when it is empty. */
export default function SignaturePad({ onChange }: { onChange: (png: string | null) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const point = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) * SIGNATURE_W / box.width, y: (event.clientY - box.top) * SIGNATURE_H / box.height };
  };
  const context = () => { const c = canvas.current!.getContext("2d")!; c.lineWidth = 3; c.lineCap = "round"; c.lineJoin = "round"; c.strokeStyle = "#0d1a4d"; return c; };
  return <div>
    <canvas ref={canvas} width={SIGNATURE_W} height={SIGNATURE_H} data-testid="signature-pad" aria-label="Draw your signature here" className="w-full max-w-xl touch-none rounded-md border-2 border-dashed border-background-400 bg-white" style={{ aspectRatio: "3 / 1" }}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; const p = point(e); const c = context(); c.beginPath(); c.moveTo(p.x, p.y); c.lineTo(p.x + 0.1, p.y + 0.1); c.stroke(); }}
      onPointerMove={(e) => { if (!drawing.current) return; const p = point(e); const c = context(); c.lineTo(p.x, p.y); c.stroke(); }}
      onPointerUp={() => { if (!drawing.current) return; drawing.current = false; onChange(canvas.current!.toDataURL("image/png").split(",")[1]); }}
      onPointerCancel={() => { drawing.current = false; }} />
    <button type="button" className="mt-2 text-sm font-medium text-primary-700 underline" onClick={() => { const c = canvas.current!; c.getContext("2d")!.clearRect(0, 0, c.width, c.height); onChange(null); }}>Clear and draw again</button>
  </div>;
}
