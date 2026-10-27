import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import FormFieldControl from "@/components/feature/FormFieldControl";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

/**
 * Public renderer for CMS-authored forms (cms_forms + cms_form_fields).
 * A form is reachable at /forms/:id exactly when it is Published in Supabase;
 * it renders with the SAME field-type rules as the CMS preview.
 */
const SUBMIT_ADDR = "https://readdy.ai/api/form/db6vsjecdv04m4p4ge4g";

export default function CmsFormPage() {
  const { id } = useParams();
  const { data } = usePublicSite();
  const form = data.forms.find((item) => item.id === id);
  const submitUrl = data.tenantSite ? (form?.submissionApproved ? form.submitUrl : undefined) : SUBMIT_ADDR;

  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  if (!form) {
    return (
      <>
        <Seo title="Form not found" description="This form is not available." path="/forms" />
        <PageHero title="Form not found" breadcrumb="Forms" />
        <section className="bg-background-50 py-16">
          <div className="site-container">
            <div className="mx-auto max-w-xl rounded-card border border-background-200 bg-background-50 p-10 text-center">
              <h2 className="font-heading text-lg font-semibold text-foreground-950">
                This form isn&apos;t available
              </h2>
              <p className="mt-2 text-sm text-foreground-600">
                It may have been unpublished, or the link is incorrect.
              </p>
              <Link
                to="/contact"
                className="mt-6 inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 hover:bg-primary-600"
              >
                Contact us
                <i className="ri-arrow-right-line" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </>
    );
  }

  const formDomId = `cms-form-${form.id}`;
  const visibleFields = form.fields.filter((field) => field.visible);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!submitUrl) { setStatus("error"); setMessage("Form submissions are not configured for this website."); return; }
    const element = event.currentTarget;
    const formData = new FormData(element);

    const honeypot = String(formData.get("website_alt") ?? "").trim();
    if (honeypot) {
      setStatus("success");
      setMessage("Thank you. Your submission has been received.");
      element.reset();
      return;
    }

    const payload = new URLSearchParams();
    payload.append("form_name", form.name);
    formData.forEach((value, key) => {
      if (key === "website_alt") return;
      if (value instanceof File) {
        if (value.name) payload.append(key, `[attachment] ${value.name}`);
        return;
      }
      const text = String(value ?? "").trim();
      if (!text) return;
      payload.append(key, text);
    });

    setStatus("submitting");
    setMessage("");

    try {
      const response = await fetch(submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
        signal: AbortSignal.timeout(15000),
      });

      const responseText = await response.text();
      let parsed: { code?: string; message?: string; meta?: { message?: string; detail?: string } } | null = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        parsed = null;
      }

      const code = parsed?.code;
      const serverMsg = parsed?.meta?.message || parsed?.message || parsed?.meta?.detail || responseText || "";
      const spamLike = /spam/i.test(String(serverMsg));

      if (response.ok && code === "OK" && !spamLike) {
        setStatus("success");
        setMessage(String(parsed?.meta?.message || "Thank you. Your submission has been received."));
        element.reset();
      } else {
        setStatus("error");
        setMessage(
          serverMsg && !spamLike
            ? String(serverMsg)
            : "We could not submit the form. Please check your details and try again.",
        );
      }
    } catch {
      setStatus("error");
      setMessage("Something went wrong while submitting. Please try again.");
    }
  };

  return (
    <>
      <Seo
        title={`${form.name} | ${data.settings.name}`}
        description={form.description || `Complete the ${form.name} form for ${data.settings.name}.`}
        path={`/forms/${form.id}`}
        jsonLd={data.tenantSite ? [] : [
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: form.name, path: `/forms/${form.id}` },
          ]),
        ]}
      />
      <PageHero title={form.name} breadcrumb="Forms" />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container max-w-3xl">
          <div className="rounded-card border border-background-200 bg-background-50 p-6 md:p-8">
            <h2 className="font-heading text-xl font-semibold text-foreground-950 md:text-2xl">{form.name}</h2>
            {form.description ? (
              <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-foreground-600">{form.description}</p>
            ) : null}

            <form id={formDomId} data-readdy-form onSubmit={handleSubmit} className="mt-6 space-y-5">
              <div className="field-antispam-website" aria-hidden="true">
                <label htmlFor={`${formDomId}-website_alt`}>Website</label>
                <input
                  id={`${formDomId}-website_alt`}
                  name="website_alt"
                  type="text"
                  tabIndex={-1}
                  autoComplete="off"
                  readOnly
                />
              </div>

              {visibleFields.length === 0 ? (
                <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                  This form has no fields yet.
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:gap-x-5">
                  {visibleFields.map((field) => {
                    const fullWidth =
                      field.type === "Textarea" ||
                      field.type === "Checkbox" ||
                      field.type === "Terms" ||
                      field.type === "Table" ||
                      field.type === "Section Heading" ||
                      field.type === "Static Note" ||
                      field.type === "File Upload";
                    return (
                      <div key={field.id} className={fullWidth ? "md:col-span-2" : ""}>
                        <FormFieldControl field={field} idPrefix={formDomId} />
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <button
                  type="submit"
                  disabled={status === "submitting"}
                  className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {status === "submitting" ? "Submitting..." : "Submit"}
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </button>
              </div>
            </form>

            {status === "success" ? (
              <p className="mt-5 rounded-md border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-900" role="status">
                {message}
              </p>
            ) : null}
            {status === "error" ? (
              <p className="mt-5 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900" role="alert">
                {message}
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}
