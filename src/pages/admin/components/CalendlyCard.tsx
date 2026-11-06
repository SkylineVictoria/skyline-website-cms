import { useEffect, useState } from "react";
import { Button, Card, Field, TextInput } from "@/pages/admin/components/ui";
import { calendlyUrlProblem } from "@/lib/calendly";
import { calendlyTokenStatus, checkCalendlyConnection, saveCalendlyToken, type CalendlyConnection, type CalendlyTokenStatus } from "@/pages/admin/lib/calendlyAdmin";

/**
 * Contact Information > Book a call (Calendly). The scheduling link is part of the page draft and goes out with
 * "Save changes"; the API token is saved on its own, straight into cms_integration_secrets, and is never shown again.
 * "Test connection" asks Calendly who the token belongs to and lists the event types so the link can be picked.
 */
export default function CalendlyCard({ url, onUrlChange }: { url: string; onUrlChange: (url: string) => void }) {
  const [status, setStatus] = useState<CalendlyTokenStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"" | "save" | "remove" | "check">("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [connection, setConnection] = useState<CalendlyConnection | null>(null);
  const urlProblem = calendlyUrlProblem(url);

  useEffect(() => {
    let on = true;
    calendlyTokenStatus().then(
      (s) => { if (on) setStatus(s); },
      (e) => { if (on) setMessage({ tone: "error", text: e instanceof Error ? e.message : "We could not check whether a token is saved." }); },
    );
    return () => { on = false; };
  }, []);

  const run = async (kind: "save" | "remove" | "check", work: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setMessage(null);
    try { await work(); }
    catch (e) { setMessage({ tone: "error", text: e instanceof Error ? e.message : "Something went wrong. Please try again." }); }
    finally { setBusy(""); }
  };

  const save = () => run("save", async () => {
    setStatus(await saveCalendlyToken(token));
    setToken("");
    setConnection(null);
    setMessage({ tone: "ok", text: "Token saved. Use \"Test connection\" to check it." });
  });
  const remove = () => run("remove", async () => {
    setStatus(await saveCalendlyToken(""));
    setConnection(null);
    setMessage({ tone: "ok", text: "Token removed." });
  });
  const check = () => run("check", async () => {
    const result = await checkCalendlyConnection();
    setConnection(result);
    setMessage({ tone: "ok", text: `Connected as ${result.name || result.email || "the Calendly account"}.` });
  });

  const savedOn = status?.updatedAt ? new Date(status.updatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
  const choices = connection
    ? [connection.schedulingUrl ? { name: "Account page (all event types)", schedulingUrl: connection.schedulingUrl, duration: 0 } : null, ...connection.eventTypes].filter((c): c is NonNullable<typeof c> => Boolean(c))
    : [];

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-heading text-base font-semibold text-foreground-950">Book a call (Calendly)</h2>
      <p className="mb-4 text-xs text-foreground-500">
        With a link saved, the public Contact page shows a "Book a call" card next to the phone and email and a booking calendar under the enquiry form. Leave the link empty to hide both.
      </p>
      <div className="space-y-4">
        <Field label="Scheduling link" hint="The Calendly page visitors book on, such as https://calendly.com/your-team/30min. Saved with the page.">
          <TextInput value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder="https://calendly.com/…" spellCheck={false} />
        </Field>
        {urlProblem ? <p className="-mt-2 text-xs text-red-700">{urlProblem}</p> : null}

        <Field label="API token" hint="A personal access token from Calendly > Integrations > API & webhooks. It is stored out of reach of the website and never shown again.">
          <div className="flex gap-2">
            <TextInput type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder={status?.configured ? "Paste a new token to replace the saved one" : "Paste the token"} />
            <Button variant="secondary" onClick={save} disabled={!token.trim() || Boolean(busy)}>{busy === "save" ? "Saving…" : "Save token"}</Button>
          </div>
        </Field>
        <p className="text-xs text-foreground-600">
          {status === null ? "Checking the saved token…" : status.configured ? `Token saved${savedOn ? ` ${savedOn}` : ""}, ends with …${status.hint}.` : "No token saved."}
          {status?.configured ? (
            <> <button type="button" onClick={remove} disabled={Boolean(busy)} className="cursor-pointer font-medium text-primary-700 hover:text-primary-800 disabled:opacity-60">{busy === "remove" ? "Removing…" : "Remove"}</button></>
          ) : null}
        </p>

        <div>
          <Button variant="outline" icon="ri-plug-line" onClick={check} disabled={!status?.configured || Boolean(busy)}>{busy === "check" ? "Checking…" : "Test connection"}</Button>
        </div>

        {message ? (
          <p role={message.tone === "error" ? "alert" : undefined} className={message.tone === "error" ? "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800" : "text-sm text-foreground-700"}>{message.text}</p>
        ) : null}

        {choices.length ? (
          <div>
            <p className="mb-2 text-[13px] font-medium text-foreground-800">Use one of these as the scheduling link</p>
            <ul className="space-y-1.5">
              {choices.map((choice) => (
                <li key={choice.schedulingUrl} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-background-200 px-3 py-2">
                  <span className="min-w-0 text-sm text-foreground-800">
                    {choice.name}{choice.duration ? <span className="text-foreground-500"> · {choice.duration} min</span> : null}
                    <span className="block truncate text-xs text-foreground-500">{choice.schedulingUrl}</span>
                  </span>
                  <Button size="sm" variant={url.trim() === choice.schedulingUrl ? "secondary" : "outline"} onClick={() => onUrlChange(choice.schedulingUrl)}>
                    {url.trim() === choice.schedulingUrl ? "In use" : "Use this"}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-foreground-500">Then "Save changes" above to publish the link.</p>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
