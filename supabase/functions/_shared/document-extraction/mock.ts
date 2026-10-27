// Deterministic synthetic provider for tests and local development. It reads no
// environment, credentials, network or storage. It is deliberately NOT reachable
// from select.ts, so deployed configuration can never enable it.
// All people, numbers and institutions below are fictitious.
import {
  failure, validConfidence, type DocumentExtractionProvider, type ExtractionCategory, type ExtractionEvidence, type ExtractionOutcome, type ExtractionRequest, type ExtractionSuccess,
} from "./contract.ts";

export const MOCK_FIXTURE_VERSION = "fixtures-v1";

export type MockScenario =
  | "fixture" | "foreign-visa-mismatch" | "ambiguous-dates" | "empty" | "unknown-options" | "with-confidence" | "invalid-confidence"
  | "timeout" | "rate-limit" | "server-error" | "malformed" | "invalid-file";

type Fixture = { detectedType: string; fields: Record<string, string>; evidence: ExtractionEvidence[]; warnings?: string[] };
const ev = (field: string, page: number | null, source: string): ExtractionEvidence => ({ field, page, source });

const FIXTURES: Record<ExtractionCategory, Fixture> = {
  Passport: {
    detectedType: "Passport",
    fields: { first_name: "Asha", last_name: "Testperson", dob: "1999-04-05", gender: "Female", nationality: "India", passport_number: "X1234567", passport_expiry: "2031-08-09", issuing_country: "India" },
    evidence: [ev("first_name", 1, "MRZ line 1"), ev("passport_number", 1, "Data page")],
  },
  "Driving Licence": {
    detectedType: "Driving Licence",
    fields: { first_name: "Asha", last_name: "Testperson", dob: "1999-04-05", address_type: "Australian Address", au_street: "1 Example Street", au_suburb: "Sydney", au_state: "NSW", au_zip: "2000", au_country: "Australia" },
    evidence: [ev("au_street", 1, "Printed address"), ev("au_state", 1, "Printed address")],
  },
  Visa: {
    detectedType: "Visa",
    fields: { holds_visa: "Yes", visa_subclass: "500", visa_grant_date: "2026-01-15", visa_grant_number: "SYN0000000001" },
    evidence: [ev("visa_subclass", 1, "Grant notice"), ev("visa_grant_date", 1, "Grant notice")],
  },
  "English Test": {
    detectedType: "English Test",
    fields: { english_type: "IELTS Academic", english_score: "7.0", english_components: "L 7.5, R 7.0, W 6.5, S 7.0", english_date: "2026-02-03", english_reference: "TRF-SYN-0001" },
    evidence: [ev("english_score", 1, "Overall band"), ev("english_components", 1, "Band table")],
  },
  Academic: {
    detectedType: "Academic",
    fields: { academic_institution: "Example Institute of Technology", academic_qualification: "Bachelor of Science", academic_program: "विज्ञान स्नातक (Computer Science)", academic_year: "2025", academic_result: "GPA 3.4/4.0" },
    evidence: [ev("academic_institution", 1, "Transcript header"), ev("academic_result", 2, "Semester summary"), ev("academic_year", 3, "Completion statement")],
  },
};


export interface MockProviderOptions { scenario?: MockScenario; model?: string }

export function createMockProvider(options: MockProviderOptions = {}): DocumentExtractionProvider {
  const scenario = options.scenario ?? "fixture";
  return {
    id: "mock",
    model: options.model ?? MOCK_FIXTURE_VERSION,
    async extract(request: ExtractionRequest): Promise<ExtractionOutcome> {
      if (request.signal.aborted) return failure("cancelled", "Extraction was cancelled.", false);
      switch (scenario) {
        case "timeout": return failure("timeout", "The extraction provider timed out.", true);
        case "rate-limit": return failure("rate_limit", "The extraction provider returned 429.", true);
        case "server-error": return failure("provider", "The extraction provider returned 503.", true);
        case "malformed": return failure("schema", "The extraction provider returned an incomplete structured response.", true);
        case "invalid-file": return failure("validation", "The provider rejected the document as unreadable.", false);
      }
      const base = FIXTURES[request.category];
      let result: ExtractionSuccess = {
        ok: true, detectedType: base.detectedType, categoryMismatch: false, fields: { ...base.fields },
        evidence: base.evidence.map((e) => ({ ...e })), warnings: [], operationId: `mock-${request.jobId}-${request.attempt}`, usage: { mock: true },
      };
      if (scenario === "foreign-visa-mismatch") result = { ...result, detectedType: "Visa", categoryMismatch: true, fields: { holds_visa: "Yes", visa_subclass: "B-2", visa_grant_number: "FOREIGN-0001" }, evidence: [ev("visa_subclass", 1, "Foreign visa foil")], warnings: ["Document is not an Australian visa grant notice."] };
      else if (scenario === "ambiguous-dates") result = { ...result, fields: { ...result.fields, dob: null, passport_expiry: null }, warnings: ["Ambiguous date 03/04/05 not interpreted."] };
      else if (scenario === "empty") result = { ...result, fields: {}, evidence: [], warnings: ["No text recognised."] };
      else if (scenario === "unknown-options") result = { ...result, fields: { nationality: "Atlantis", gender: "X" } };
      else if (scenario === "with-confidence") result = { ...result, confidence: { first_name: 0.98, passport_number: 0.91 } };
      else if (scenario === "invalid-confidence") result = { ...result, confidence: validConfidence({ first_name: 1.7 }) };
      return result;
    },
  };
}
