import { refuseHosted } from "./lab/hosted-guard.mjs";
refuseHosted("test-portal-document-attachments"); // local stack only; --allow-hosted to override (scripts/lab/hosted-guard.mjs)
import assert from "node:assert/strict";
import test from "node:test";
import { documentCategoryForField, extractionStatus } from "../src/pages/agency/lib/documentAttachments.ts";

test("agency attachment fields map only to their persisted document categories", () => {
  assert.equal(documentCategoryForField("passport_copy"), "Passport");
  assert.equal(documentCategoryForField("visa_copy"), "Visa");
  assert.equal(documentCategoryForField("english_upload"), "English Test");
  assert.equal(documentCategoryForField("academic_upload"), "Academic");
  assert.equal(documentCategoryForField("unrelated_file"), null);
});

test("extraction state comes from persisted document metadata", () => {
  assert.equal(extractionStatus({}), "Not requested");
  assert.equal(extractionStatus({ extraction: { status: "queued" } }), "queued");
  assert.equal(extractionStatus({ extraction: { status: "failed" } }), "failed");
});

// DOCUMENT-CARRY (owner 2026-11-26): documents copied from the student's earlier application.
import { carriedFromLabel } from "../src/pages/agency/lib/documentAttachments.ts";
import { carryTargetPath } from "../supabase/functions/validated-document-upload/carry.ts";

test("a copied document is labelled From your previous application", () => {
  assert.equal(carriedFromLabel({}), null);
  assert.equal(carriedFromLabel(undefined), null);
  assert.equal(carriedFromLabel({ carriedFrom: { documentId: "d1", reference: "SLIT-2026-0126" } }), "From your previous application (SLIT-2026-0126)");
  assert.equal(carriedFromLabel({ carriedFrom: { documentId: "d1" } }), "From your previous application");
  assert.equal(carriedFromLabel({ carriedFrom: { reference: "SLIT-2026-0126" } }), null, "no source document, no label");
});

test("a copied file is a new object in the new application's folder", () => {
  const app = "a17bdae0-cd97-4f60-9a2a-15930f4b04da";
  const path = carryTargetPath(app, "f5a6cc3e-c91c-44da-b575-00473dbd70b9/validated-07a95ec6.PDF", "11111111-2222-3333-4444-555555555555");
  assert.equal(path, `${app}/validated-11111111-2222-3333-4444-555555555555.pdf`);
  assert.ok(!path.startsWith("f5a6cc3e"), "never the old application's folder");
  assert.equal(carryTargetPath(app, "old/validated-x", "id"), `${app}/validated-id`);
  assert.equal(carryTargetPath(app, "old/validated-x.p<d>f", "id"), `${app}/validated-id.pdf`);
});
