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
