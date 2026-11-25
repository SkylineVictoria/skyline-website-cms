import { supabase } from "@/pages/admin/lib/supabase";

export type CountryRow = { code: string; label: string };

/** Countries from avetmiss_codes 'country' matching the text (avetmiss_code_search), without "Not stated". */
export async function searchCountries(query: string, limit = 20): Promise<CountryRow[]> {
  const { data, error } = await supabase.rpc("avetmiss_code_search", { p_set: "country", p_query: query, p_limit: limit });
  if (error) throw new Error(error.message);
  return ((data ?? []) as CountryRow[]).filter((row) => row.code !== "@@@@");
}
