import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile for the public staff application. The site key is public (VITE_CAPTCHA_SITE_KEY); the server verifies the
 * token with its secret. "local-mock" renders a plain checkbox that yields the token the local mock verifier accepts ("mock-ok");
 * the server only honours that mock against a local Supabase URL. Without a site key the form cannot be sent.
 */
const SITE_KEY = ((import.meta.env.VITE_CAPTCHA_SITE_KEY as string | undefined) ?? "").trim();
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const CAPTCHA_LOCAL_MOCK = "local-mock";
export const captchaConfigured = SITE_KEY !== "";

interface TurnstileApi {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id?: string): void;
  remove(id: string): void;
}
declare global { interface Window { turnstile?: TurnstileApi } }

let loading: Promise<TurnstileApi> | null = null;
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.referrerPolicy = "no-referrer";
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("unavailable")));
    script.onerror = () => { loading = null; reject(new Error("unavailable")); };
    document.head.appendChild(script);
  });
  return loading;
}

/** Calls onToken with a fresh token, or "" when it expires or fails. Bump `resetKey` to ask for a new check after a failed send. */
export default function StaffCaptcha({ onToken, resetKey = 0 }: { onToken: (token: string) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [mockChecked, setMockChecked] = useState(false);

  useEffect(() => {
    onToken("");
    if (SITE_KEY === CAPTCHA_LOCAL_MOCK) { setMockChecked(false); return; }
    if (!SITE_KEY || !box.current) return;
    let id: string | null = null;
    let cancelled = false;
    loadTurnstile().then((api) => {
      if (cancelled || !box.current) return;
      id = api.render(box.current, {
        sitekey: SITE_KEY,
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(""),
        "error-callback": () => { onToken(""); setFailed(true); },
      });
    }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; if (id && window.turnstile) window.turnstile.remove(id); };
    // onToken is a state setter from the parent; re-render only when a reset is asked for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!SITE_KEY) return <p role="alert" className="text-[13px] text-primary-900">Staff applications are not available right now. Please try again later.</p>;
  if (SITE_KEY === CAPTCHA_LOCAL_MOCK) {
    return (
      <label className="flex items-center gap-2 rounded-md border border-dashed border-background-400 px-3 py-2 text-sm text-foreground-700">
        <input type="checkbox" checked={mockChecked} data-testid="staff-captcha-mock"
          onChange={(e) => { setMockChecked(e.target.checked); onToken(e.target.checked ? "mock-ok" : ""); }} />
        Security check (local mock)
      </label>
    );
  }
  return (
    <div>
      <div ref={box} />
      {failed ? <p role="alert" className="mt-1 text-[13px] text-primary-900">The security check could not load. Refresh the page and try again.</p> : null}
    </div>
  );
}
