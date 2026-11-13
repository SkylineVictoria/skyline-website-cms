import { useState, type FormEvent } from "react";

export type FormField = {
  name: string;
  label: string;
  type: "text" | "email" | "tel" | "select" | "textarea";
  required?: boolean;
  placeholder?: string;
  options?: string[];
  fullWidth?: boolean;
};

type EnquiryFormProps = {
  formId: string;
  submitAddr: string;
  title: string;
  description?: string;
  submitLabel?: string;
  fields: FormField[];
  compact?: boolean;
};

const fieldClass =
  "w-full rounded-md border border-background-300 bg-background-50 px-4 py-3 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

export default function EnquiryForm({
  formId,
  submitAddr,
  title,
  description,
  submitLabel = "Submit",
  fields,
  compact = false,
}: EnquiryFormProps) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [message, setMessage] = useState("");

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const honeypot = String(formData.get("website_alt") ?? "").trim();
    if (honeypot) {
      setStatus("success");
      setMessage("Thank you. Your enquiry has been received.");
      form.reset();
      return;
    }

    const payload = new URLSearchParams();
    formData.forEach((value, key) => {
      if (key === "website_alt") return;
      const text = String(value ?? "").trim();
      if (!text) return;
      payload.append(key, text);
    });

    setStatus("submitting");
    setMessage("");

    try {
      const response = await fetch(submitAddr, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: payload.toString(),
      });

      const responseText = await response.text();
      let parsed: {
        code?: string;
        message?: string;
        meta?: { message?: string; detail?: string };
      } | null = null;
      try {
        parsed = responseText ? JSON.parse(responseText) : null;
      } catch {
        parsed = null;
      }

      const code = parsed?.code;
      const serverMsg =
        parsed?.meta?.message || parsed?.message || parsed?.meta?.detail || responseText || "";
      const spamLike = /spam/i.test(String(serverMsg));

      if (response.ok && code === "OK" && !spamLike) {
        setStatus("success");
        setMessage(String(parsed?.meta?.message || "Thank you. Your enquiry has been received."));
        form.reset();
      } else {
        setStatus("error");
        setMessage(
          serverMsg && !spamLike
            ? String(serverMsg)
            : "We could not submit your enquiry. Please check your details and try again.",
        );
      }
    } catch {
      setStatus("error");
      setMessage("Something went wrong while submitting. Please try again.");
    }
  };

  return (
    <div className="rounded-card border border-background-200 bg-background-50 p-6 md:p-8">
      <h3 className="font-heading text-xl font-semibold text-foreground-950 md:text-2xl">{title}</h3>
      {description ? (
        <p className="mt-3 whitespace-pre-line text-base leading-relaxed text-foreground-600">{description}</p>
      ) : null}

      <form
        id={formId}
        data-readdy-form
        onSubmit={handleSubmit}
        className={`mt-6 grid grid-cols-1 gap-4 ${compact ? "" : "md:grid-cols-2"}`}
      >
        <div className="field-antispam-website" aria-hidden="true">
          <label htmlFor={`${formId}-website_alt`}>Website</label>
          <input
            id={`${formId}-website_alt`}
            name="website_alt"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            readOnly
          />
        </div>

        {fields.map((field) => (
          <div key={field.name} className={field.fullWidth || field.type === "textarea" ? "md:col-span-2" : ""}>
            <label
              htmlFor={`${formId}-${field.name}`}
              className="mb-2 block text-sm font-medium text-foreground-800"
            >
              {field.label}
              {field.required ? <span className="ml-1 text-primary-600">*</span> : null}
            </label>
            {field.type === "textarea" ? (
              <textarea
                id={`${formId}-${field.name}`}
                name={field.name}
                rows={5}
                maxLength={500}
                required={field.required}
                placeholder={field.placeholder}
                className={fieldClass}
              />
            ) : field.type === "select" ? (
              <select
                id={`${formId}-${field.name}`}
                name={field.name}
                required={field.required}
                defaultValue=""
                className={fieldClass}
              >
                <option value="" disabled>
                  Select
                </option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${formId}-${field.name}`}
                name={field.name}
                type={field.type}
                required={field.required}
                placeholder={field.placeholder}
                className={fieldClass}
              />
            )}
          </div>
        ))}

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={status === "submitting"}
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md bg-primary-500 px-6 py-3 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {status === "submitting" ? "Submitting..." : submitLabel}
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
  );
}