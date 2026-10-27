import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/** Whether a Supabase session exists. Display only (header Sign In / Dashboard); it grants nothing. */
export function useSignedIn(): boolean {
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => { if (active) setSignedIn(Boolean(data.session)); }).catch(() => undefined);
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => { setSignedIn(Boolean(session)); });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  return signedIn;
}
