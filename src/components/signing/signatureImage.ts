/* The signature picture format of the signing page (/sign) and the CMS (2026-11-17): a 600 x 200 PNG, base64 without the data: prefix,
 * the one format the server accepts. Shared by the pad (SignaturePad.tsx) and the picture upload. */
export const SIGNATURE_W = 600, SIGNATURE_H = 200;
/** Any picture, scaled into a 600 x 200 PNG (base64 without the data: prefix): the one format the server accepts. */
export async function pictureToPng(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 5 * 1024 * 1024) throw new Error("Choose a PNG or JPEG picture of your signature, 5 MB or smaller.");
  const image = await createImageBitmap(file);
  const scale = Math.min(SIGNATURE_W / image.width, SIGNATURE_H / image.height, 1);
  const canvas = document.createElement("canvas"); canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale));
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1];
}

