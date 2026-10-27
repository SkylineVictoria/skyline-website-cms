import type { AppField, FieldCondition } from "@/data/applicationForms";

export const baseFieldClass =
  "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

export function isConditionMet(condition: FieldCondition | undefined, values: Record<string, string>): boolean {
  if (!condition) return true;
  return condition.equals.includes(values[condition.field] ?? "");
}

export function isFieldFilled(form: HTMLFormElement, field: AppField): boolean {
  if (field.type === "checkbox") {
    const nodes = form.querySelectorAll<HTMLInputElement>(`input[name="${field.name}[]"]`);
    return Array.from(nodes).some((node) => node.checked);
  }
  if (field.type === "radio") {
    return Boolean(form.querySelector(`input[name="${field.name}"]:checked`));
  }
  if (field.type === "file") {
    const input = form.querySelector<HTMLInputElement>(`input[name="${field.name}"]`);
    return Boolean(input && (input.files?.length ?? 0) > 0);
  }
  const control = form.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
    `[name="${field.name}"]`,
  );
  if (!control) return false;
  return control.value.trim() !== "";
}

export function sectionHeading(title: string | undefined, index: number): string {
  if (!title) return `Section ${index + 1}`;
  return title.replace(/^\s*\d+[a-z]?\.\s*/i, "").trim() || title;
}

export function sectionIcon(title: string | undefined): string {
  const text = (title ?? "").toLowerCase();
  if (text.includes("scan") || text.includes("quick start")) return "ri-scan-2-line";
  if (text.includes("personal")) return "ri-user-line";
  if (text.includes("address")) return "ri-map-pin-2-line";
  if (text.includes("passport") || text.includes("visa")) return "ri-id-card-line";
  if (text.includes("academic")) return "ri-file-text-line";
  if (text.includes("identifier") || text.includes("avetmiss")) return "ri-fingerprint-line";
  if (text.includes("unique student") || text.includes("usi")) return "ri-shield-user-line";
  if (text.includes("emergency")) return "ri-phone-line";
  if (text.includes("course information")) return "ri-graduation-cap-line";
  if (text.includes("study reason")) return "ri-book-open-line";
  if (text.includes("credit")) return "ri-award-line";
  if (text.includes("health") || text.includes("oshc")) return "ri-heart-pulse-line";
  if (text.includes("hear")) return "ri-question-line";
  if (text.includes("checklist")) return "ri-checkbox-multiple-line";
  if (text.includes("declaration")) return "ri-quill-pen-line";
  if (text.includes("company")) return "ri-building-line";
  if (text.includes("contact")) return "ri-contacts-line";
  if (text.includes("profile")) return "ri-profile-line";
  if (text.includes("reference")) return "ri-user-star-line";
  if (text.includes("attachment")) return "ri-attachment-line";
  if (text.includes("consent")) return "ri-shield-check-line";
  return "ri-file-list-3-line";
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}
