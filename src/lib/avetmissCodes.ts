import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/**
 * AVETMISS-UI (2026-11-25): every AVETMISS dropdown reads public.avetmiss_codes (code_set, code, label, sort, is_active): labels are
 * shown, codes are saved, options in `sort` order. Inactive codes are hidden from new choices but a value already saved still shows
 * its label. Loaded once per page load (one small table, readable by everyone).
 */
export type AvetmissCodeSet =
  | "country" | "language" | "commencing" | "disability_type" | "english_proficiency" | "flag" | "funding_source" | "indigenous_status" | "labour_force" | "org_type"
  | "outcome" | "predominant_delivery_mode" | "prior_education" | "prior_education_recognition" | "school_level" | "sex" | "state" | "study_reason";

export interface AvetmissCode { code_set: string; code: string; label: string; sort: number; is_active: boolean }
export type AvetmissCodes = Record<string, AvetmissCode[]>;

let cache: Promise<AvetmissCodes> | null = null;

export function loadAvetmissCodes(): Promise<AvetmissCodes> {
  cache ??= (async () => {
    const sets: AvetmissCodes = {};
    const pageSize = 200;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await supabase.from("avetmiss_codes")
        .select("code_set, code, label, sort, is_active")
        .order("code_set").order("sort").order("code").range(offset, offset + pageSize - 1);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as AvetmissCode[];
      for (const row of rows) (sets[row.code_set] ??= []).push(row);
      if (rows.length < pageSize) break;
    }
    return sets;
  })().catch((error: unknown) => { cache = null; throw error; });
  return cache;
}

/** The code lists for a page; `{}` until loaded. */
export function useAvetmissCodes(): { codes: AvetmissCodes; error: string } {
  const [codes, setCodes] = useState<AvetmissCodes>({});
  const [error, setError] = useState("");
  useEffect(() => { let live = true; void loadAvetmissCodes().then((c) => { if (live) setCodes(c); }, (e: Error) => { if (live) setError(e.message); }); return () => { live = false; }; }, []);
  return { codes, error };
}

/** Options for a dropdown: active codes in sort order, plus the current value when it is inactive (so it still shows). */
export function avetmissOptions(codes: AvetmissCodes, set: AvetmissCodeSet, current?: string | null): AvetmissCode[] {
  const all = codes[set] ?? [];
  return all.filter((c) => c.is_active || c.code === current);
}

/** "Label (code)" for a saved code, or "" when there is none; an unknown code shows as itself. */
export function avetmissLabel(codes: AvetmissCodes, set: AvetmissCodeSet, code?: string | null): string {
  if (!code) return "";
  const hit = (codes[set] ?? []).find((c) => c.code === code);
  return hit ? hit.label : code;
}

/** Resolves current codes and the labels saved by older application drafts. */
export function activeAvetmissCode(codes: AvetmissCodes, set: AvetmissCodeSet, value: string): string | undefined {
  const answer = value.trim().toLowerCase();
  return codes[set]?.find((row) => row.is_active && (row.code.toLowerCase() === answer || row.label.toLowerCase() === answer))?.code;
}
