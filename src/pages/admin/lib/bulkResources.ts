import { supabase } from "./supabase";

export const bulkBucket = "lms-bulk-resources";
export const categories = ["learning", "assessment", "self_assessment", "assessor"] as const;
export type Category = typeof categories[number];
export const categoryLabels: Record<Category, string> = {
  learning: "Learning Materials", assessment: "Assessments", self_assessment: "Self-Assessment", assessor: "Assessor Resources",
};
export const accessLabels = { student_staff: "Student & Staff", staff: "Staff", assessor: "Assessor only" };
export type Audience = keyof typeof accessLabels;
export type BulkPolicy = {
  max_mib: number; max_files: number; confidence: number; formats: string[];
  default_audience: Audience; duplicates: "review" | "skip_identical"; allow_publication: boolean; confirm_each: boolean;
} & Record<`${Category}_label`, string>;
export type ImportJob = { id: string; unit_hint: string | null; created_at: string; created_by: string };
export type UnitOption = { id: string; course_id: string; code: string; name: string };
export type CourseOption = { id: string; code: string; name: string };
export type ImportFile = {
  id: string; name: string; source_path: string; object_path: string; bytes: number; extension: string;
  state: "uploading" | "queued" | "processing" | "extracted" | "review" | "failed" | "excluded" | "imported";
  result: null | {
    title: string; category: Category; confidence: number; courseCode: string | null; unitCode: string | null;
    confidentiality: "student_safe" | "assessor_only" | "mixed" | "unknown"; explanation: string; documentType: string;
    qualification: string | null; intendedAudience: string; assessmentPurpose: string | null; evidence: string;
  };
  matches?: UnitOption[];
  related?: { id: string; unit_id: string; title: string; identical: boolean }[];
  usage?: { estimated_usd: number | null; input: number; output: number } | null;
  failure: string | null;
};
export type Resource = { id: string; unit_id: string; title: string; category: Category; audience: Audience; published_at: string | null;
  path: string; name: string; bytes: number; previous_id: string | null; assessment_id: string | null; security_hold: boolean };

export function categoryLabel(key: Category, policy?: BulkPolicy | null) {
  return policy?.[`${key}_label`] || categoryLabels[key];
}

export async function bulkAdmin<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const result = await supabase.rpc("lms_bulk_admin", { p_action: action, p_data: data });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}
export async function listResources(unit: string | null): Promise<Resource[]> {
  const result = await supabase.rpc("lms_bulk_resources", { p_unit: unit });
  if (result.error) throw new Error(result.error.message);
  return result.data as Resource[];
}
export async function downloadResource(path: string, name: string) {
  const result = await supabase.storage.from(bulkBucket).download(path);
  if (result.error || !result.data) throw new Error("This file could not be opened with your current permissions.");
  const url = URL.createObjectURL(result.data);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
