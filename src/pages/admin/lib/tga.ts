// Calls to the tga-course-import Edge Function. training.gov.au answers from Australia only, so the function always runs in
// Sydney (forceFunctionRegion in the URL; the x-region header is refused by its CORS rules). An expired sign-in token gets a
// 401 from the function: the session is refreshed and the call made once more, so an import does not fail at random.
import { supabase } from "@/pages/admin/lib/supabase";

const URL = "tga-course-import?forceFunctionRegion=ap-southeast-2";

export async function invokeTga<T>(body: Record<string, unknown>) {
  await supabase.auth.getSession(); // refreshes a token that has expired
  let out = await supabase.functions.invoke<T>(URL, { body });
  const status = (out.error as { context?: Response } | null)?.context?.status;
  if (status === 401) {
    const { error } = await supabase.auth.refreshSession();
    if (!error) out = await supabase.functions.invoke<T>(URL, { body });
  }
  return out;
}
