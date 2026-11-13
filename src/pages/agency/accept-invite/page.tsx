import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "@/pages/admin/lib/supabase";
import { loginUrl } from "@/lib/loginRouting";

/**
 * /agency/accept-invite#t=<token>: the "Activate access" link from an invitation email (INV-LINK). The token is the proof the
 * invited person received the email; the database records it, and portal access starts at their next sign-in.
 * The token stays in the URL fragment (never sent to a server log) and is removed from the address bar once read.
 */
export default function AcceptInvitePage() {
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("");
  const [alreadyActive, setAlreadyActive] = useState(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("t") ?? "";
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
    if (!token) { setState("error"); setMessage("This invitation link is incomplete. Open it again from the email."); return; }
    let active = true;
    supabase.functions.invoke("portal-invite-activate", { body: { token } }).then(async ({ data, error }) => {
      if (!active) return;
      if (error || !data?.ok) {
        let text = "This invitation link is not valid or has expired.";
        const context = (error as { context?: unknown } | null)?.context;
        if (context instanceof Response) { try { text = ((await context.clone().json()) as { error?: string }).error || text; } catch { /* keep */ } }
        setState("error"); setMessage(text); return;
      }
      // Anyone signed in on this browser (possibly someone else) is signed out first.
      await supabase.auth.signOut().catch(() => undefined);
      if (!active) return;
      // Straight on to "Set your password" for this email; that page accepts the invitation once the password is saved.
      if (typeof data.passwordLink === "string" && /^https:\/\//.test(data.passwordLink)) { window.location.replace(data.passwordLink); return; }
      setAlreadyActive(data.alreadyActive === true);
      setState("done");
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background-100 px-5">
      <div className="w-full max-w-md rounded-card border border-background-200 bg-background-50 p-6 text-center">
        {state === "working" ? (
          <p className="text-sm text-foreground-600" aria-live="polite">Activating your access&hellip; you&rsquo;ll create your password next.</p>
        ) : state === "done" ? (
          <>
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-green-50 text-xl text-green-700"><i className="ri-check-line" aria-hidden="true" /></span>
            <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">{alreadyActive ? "Your access is already active" : "Your access is activated"}</h1>
            <p className="mt-2 text-sm text-foreground-600">Sign in to open the portal. If you don&rsquo;t know your password, use &ldquo;Forgot password?&rdquo; on the sign-in page.</p>
            <Link to={loginUrl("/agency")} className="mt-5 inline-block rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">Sign in</Link>
          </>
        ) : (
          <>
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary-50 text-xl text-primary-600"><i className="ri-error-warning-line" aria-hidden="true" /></span>
            <h1 className="mt-4 font-heading text-lg font-bold text-foreground-950">We couldn&rsquo;t activate your access</h1>
            <p role="alert" className="mt-2 text-sm text-foreground-600">{message} Ask the person who invited you to resend the invitation.</p>
          </>
        )}
      </div>
    </div>
  );
}
