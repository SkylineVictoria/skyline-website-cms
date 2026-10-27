import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Source contract only (regex): the upstream request now lives in the OpenAI adapter. Behavioural
// proof is scripts/test-document-provider.ts and the native lab, not this check.
const worker = await readFile("supabase/functions/_shared/document-extraction/openai.ts", "utf8");

assert.match(worker, /inputMime === "application\/pdf"/);
assert.match(worker, /type: "input_file", filename: request\.filename, file_data: dataUrl/);
assert.match(worker, /type: "input_image", image_url: dataUrl, detail: "high"/);
assert.doesNotMatch(worker, /content: \[\{ type: "input_file", filename: request\.filename, file_data:/);

console.log("document extraction request contract: PDFs use input_file; JPEG/PNG use input_image");
