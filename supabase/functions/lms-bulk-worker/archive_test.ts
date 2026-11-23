import { zipSync, strToU8 } from "npm:fflate@0.8.3";
import { extractEntry, readArchive } from "./archive.ts";
import { checkSignature, classify, type Settings } from "./classify.ts";

const mib = 1024 * 1024;
const verify = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const rejects = (run: () => unknown, message: string) => {
  try { run(); } catch (error) {
    verify(error instanceof Error && error.message.includes(message), String(error));
    return;
  }
  throw new Error("Expected rejection");
};

Deno.test("archives preserve paths and safely extract 105 files across two packages", () => {
  const batches = [55, 50].map((count, batch) => zipSync(Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`unit-${batch}/document-${index}.pdf`, strToU8(`%PDF-1.4\nDocument ${index}`)]),
  )));
  let count = 0;
  for (const archive of batches) {
    const entries = readArchive(archive, 2 * mib, 110);
    count += entries.length;
    for (const entry of entries) checkSignature(extractEntry(archive, entry), "pdf");
  }
  verify(count === 105, "Incorrect file count");
});

Deno.test("ZIP validation rejects malformed metadata, unsafe paths and expansion outside limits", () => {
  const settings = [mib, 100] as const;
  rejects(() => readArchive(new Uint8Array(42), ...settings), "Invalid");
  rejects(() => readArchive(zipSync({ "../outside.pdf": strToU8("%PDF-") }), ...settings), "unsafe");
  rejects(() => readArchive(zipSync({ "nested\\name.pdf": strToU8("%PDF-") }), ...settings), "unsafe");
  const small = zipSync({ "document.pdf": strToU8("%PDF-") }, { level: 0 });
  const entry = readArchive(small, ...settings)[0];
  small[entry.start] ^= 1;
  rejects(() => extractEntry(small, entry), "unsafe");
  rejects(() => readArchive(zipSync({ "document.pdf": new Uint8Array(100_000) }), ...settings), "expansion");
  rejects(() => readArchive(zipSync({ "document.pdf": new Uint8Array(4096) }, { level: 0 }), 4095, 100), "expansion");
  rejects(() => checkSignature(strToU8("<html>"), "pdf"), "declared format");
});

Deno.test("classifier sends actual PDF bytes and preserves structured usage with document-derived confidence", async () => {
  const bytes = strToU8("%PDF-1.4\nAssessment Benchmarks");
  const settings = { instructions: "SLIT test instructions" } as Settings;
  const mockedProvider = async (_: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    verify(request.store === false, "Provider request stores submitted material");
    const document = request.input[0].content[1];
    verify(document.type === "input_file" && atob(document.file_data.split(",")[1]).includes("Assessment Benchmarks"), "Missing content");
    return Response.json({ status: "completed", usage: { input_tokens: 720, output_tokens: 210 }, output_text: JSON.stringify({
      title: "Assessment Benchmarks", documentType: "Marking guide", category: "assessor", confidentiality: "assessor_only",
      courseCode: "CPC30620", unitCode: "CPCCWHS2001", qualification: "Certificate III in Painting and Decorating",
      intendedAudience: "Assessors", assessmentPurpose: "Marking guidance", confidence: 93.2,
      explanation: "The content contains a marking guide.", evidence: "The heading says Assessment Benchmarks.",
    }) });
  };
  const result = await classify(bytes, "pdf", "example.pdf", "folder/example.pdf", settings,
    { apiKey: "mock-key", model: "mock-model", inputPrice: 2, outputPrice: 5 }, mockedProvider);
  verify(result.classification.confidence === 93.2 && result.classification.category === "assessor", "Result was replaced");
  verify(result.usage.estimated_usd === 0.00249, "Provider usage was not priced");
  try {
    await classify(bytes, "pdf", "example.pdf", "example.pdf", settings, { apiKey: "", model: "" }, mockedProvider);
  } catch (error) {
    verify(error instanceof Error && error.message.includes("unavailable"), "Missing provider must fail closed");
    return;
  }
  throw new Error("Expected provider configuration failure");
});
