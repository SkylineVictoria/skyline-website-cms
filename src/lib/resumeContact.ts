import { jobFileMime } from "./jobs";
import { toE164 } from "./staffPhone";

export interface ResumeContact {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
}

const MAX_HEADER_LINES = 25;
const MAX_TEXT_LENGTH = 12_000;
const MAX_DOCX_XML_SIZE = 512_000;
const WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const SECTION = /^(?:summary|profile|objective|work experience|employment(?: history)?|professional experience|education|skills|references|referees)\s*:?$/i;
const NON_NAME = /\b(?:resume|résumé|curriculum vitae|cv|personal details|contact|trainer|teacher|engineer|developer|manager|consultant|specialist|assistant|director|officer|analyst)\b/i;
const NAME_WORD = /^[\p{L}][\p{L}\p{M}'’.-]*$/u;

function findName(lines: string[]): Pick<ResumeContact, "firstName" | "lastName"> {
  const explicit = lines.find((line) => /^(?:full\s+)?name\s*:/i.test(line));
  const leading = lines.slice(0, 5).find((line) =>
    line.includes(" ") && !NON_NAME.test(line) && !/[@:\d]/.test(line) && line.split(" ").every((word) => NAME_WORD.test(word)),
  );
  const name = explicit?.replace(/^(?:full\s+)?name\s*:\s*/i, "") ?? leading;
  if (!name || name.length > 100) return {};
  const parts = name.split(" ");
  if (parts.length < (explicit ? 1 : 2) || parts.length > 5 || !parts.every((word) => NAME_WORD.test(word))) return {};
  const [firstName, ...surname] = parts;
  return { firstName, lastName: surname.join(" ") };
}

function onlyMatch(values: string[]): string | undefined {
  const unique = new Set(values);
  return unique.size === 1 ? values[0] : undefined;
}

export function resumeContactFromText(text: string): ResumeContact {
  const lines = text.slice(0, MAX_TEXT_LENGTH).split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean).slice(0, MAX_HEADER_LINES);
  const sectionStart = lines.findIndex((line) => SECTION.test(line));
  const header = sectionStart >= 0 ? lines.slice(0, sectionStart) : lines;
  const email = onlyMatch(header.flatMap((line) => [...line.matchAll(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,}/gi)]
    .map(([address]) => address.toLowerCase()).filter((address) => address.length <= 254)));
  const phone = onlyMatch(header.flatMap((line) => [...line.matchAll(/(?<![\w@])(?:\+|00|04)(?:[0-9(). \t-]){7,28}\d(?!\w)/g)]
    .flatMap(([value]) => {
      const number = toE164(value);
      return number && (!number.startsWith("+61") || /^\+614\d{8}$/.test(number)) ? [number] : [];
    })));
  const firstContact = header.findIndex((line) => /@|\d{2}|^(?:email|phone|mobile)\s*:/i.test(line));
  return { ...findName(firstContact >= 0 ? header.slice(0, firstContact) : header), email, phone };
}

async function readPdf(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  const [pdf, worker] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  signal.throwIfAborted();
  pdf.GlobalWorkerOptions.workerSrc = worker.default;
  const task = pdf.getDocument({ data: bytes, stopAtErrors: true, useWasm: false });
  const cancel = () => { void task.destroy().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const doc = await task.promise;
    let text = "";
    for (let index = 1; index <= Math.min(2, doc.numPages) && text.length < MAX_TEXT_LENGTH; index++) {
      signal.throwIfAborted();
      const page = await doc.getPage(index);
      const content = await page.getTextContent();
      let previous: { y: number; endX: number } | undefined;
      for (const item of content.items) {
        if (!("str" in item)) continue;
        const [, , , , x, y] = item.transform;
        if (previous && Math.abs(y - previous.y) > 3) text += "\n";
        else if (previous && x - previous.endX > 1) text += " ";
        text += item.str + (item.hasEOL ? "\n" : "");
        previous = item.hasEOL ? undefined : { y, endX: x + item.width };
        if (text.length >= MAX_TEXT_LENGTH) break;
      }
      text += "\n";
    }
    return text;
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!signal.aborted) await task.destroy();
  }
}

async function readDocx(bytes: Uint8Array, signal: AbortSignal): Promise<string> {
  const { unzipSync, strFromU8 } = await import("fflate");
  signal.throwIfAborted();
  const path = "word/document.xml";
  const document = unzipSync(bytes, { filter: (entry) => entry.name === path && entry.originalSize <= MAX_DOCX_XML_SIZE })[path];
  if (!document || document.byteLength > MAX_DOCX_XML_SIZE) return "";
  const xml = strFromU8(document);
  if (/<!DOCTYPE/i.test(xml)) return "";
  const tree = new DOMParser().parseFromString(xml, "application/xml");
  if (tree.getElementsByTagName("parsererror").length) return "";
  return Array.from(tree.getElementsByTagNameNS(WORD_NS, "p")).slice(0, MAX_HEADER_LINES * 2).map((paragraph) =>
    Array.from(paragraph.getElementsByTagNameNS(WORD_NS, "*")).map((element) => {
      if (element.localName === "t") return element.textContent;
      if (element.localName === "br") return "\n";
      return element.localName === "tab" ? " " : "";
    }).join(""),
  ).join("\n");
}

/** Read text from the local file only. The existing application flow handles the eventual upload. */
export async function readResumeContact(file: File, signal: AbortSignal): Promise<ResumeContact> {
  const mime = jobFileMime(file);
  if (mime !== "application/pdf" && mime !== "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return {};
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const text = mime === "application/pdf" ? await readPdf(bytes, signal) : await readDocx(bytes, signal);
  return resumeContactFromText(text);
}
