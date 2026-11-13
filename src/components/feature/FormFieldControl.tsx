import { acceptAttribute, type RenderField } from "@/lib/formFields";

/**
 * The single field-type renderer used everywhere:
 *   • the CMS Form Builder live preview (disabled=true)
 *   • the public CMS form page (disabled=false)
 *
 * Rendering rules per type:
 *   Text / Email / Phone → text input   (with placeholder + max length)
 *   Textarea             → multiline textarea (rows)
 *   Number               → number input (min / max / step)
 *   Date                 → date input   (min / max)
 *   Dropdown             → <select>
 *   Radio                → radio button group (NOT a dropdown)
 *   Checkbox             → checkbox group, or a single checkbox when no options
 *   File Upload          → file input (accepted types + max size)
 *   Section Heading / Static Note / Terms / Table → non-input blocks
 */

const inputClass =
  "w-full rounded-md border border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-950 placeholder:text-foreground-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-400/40";

const labelClass = "mb-1.5 block text-label font-medium text-foreground-800";

export default function FormFieldControl({
  field,
  disabled = false,
  idPrefix = "field",
}: {
  field: RenderField;
  disabled?: boolean;
  idPrefix?: string;
}) {
  const inputId = `${idPrefix}-${field.id}`;

  if (field.type === "Section Heading") {
    return (
      <div className="border-t border-background-200 pt-3 first:border-none first:pt-0">
        <p className="font-heading text-label font-bold uppercase tracking-wide text-foreground-950">{field.label}</p>
        {field.help ? <p className="mt-1 text-xs text-foreground-500">{field.help}</p> : null}
      </div>
    );
  }

  if (field.type === "Static Note") {
    return (
      <p className="rounded-md border border-background-200 bg-background-100 px-3.5 py-2.5 text-xs font-semibold uppercase leading-relaxed tracking-wide text-foreground-700">
        {field.label}
      </p>
    );
  }

  if (field.type === "Terms") {
    return (
      <div className="rounded-md border border-background-200 bg-background-50 p-4">
        <p className="text-label font-semibold text-foreground-800">{field.label}</p>
        <ul className="mt-2 space-y-1.5">
          {(field.options.length ? field.options : ["Term 1"]).map((option, index) => (
            <li key={`${option}-${index}`} className="flex items-start gap-2 text-xs text-foreground-600">
              <input type="checkbox" disabled={disabled} className="mt-0.5 accent-primary-500" />
              <span className="leading-snug">{option}</span>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (field.type === "Table") {
    const headers = field.options.length ? field.options : ["Column"];
    return (
      <div className="overflow-x-auto rounded-md border border-background-200">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-background-100 text-foreground-700">
            <tr>
              {headers.map((header, index) => (
                <th key={`${header}-${index}`} className="border-b border-background-200 px-3 py-2 font-semibold">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {headers.map((header, index) => (
                <td key={`${header}-cell-${index}`} className="px-3 py-2 text-foreground-400">
                  —
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  const wrapperClass = field.visible ? "" : "opacity-40";

  return (
    <div className={wrapperClass}>
      {field.type !== "Checkbox" ? (
        <label className={labelClass} htmlFor={inputId}>
          {field.label || "Untitled field"}
          {field.required ? <span className="text-primary-600"> *</span> : null}
        </label>
      ) : null}

      {field.type === "Dropdown" ? (
        <select
          id={inputId}
          name={field.id}
          disabled={disabled}
          required={field.required}
          defaultValue={field.defaultValue || ""}
          className={inputClass}
        >
          <option value="" disabled>
            {field.placeholder || "Select"}
          </option>
          {(field.options.length ? field.options : ["Option"]).map((option, index) => (
            <option key={`${option}-${index}`} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.type === "Radio" ? (
        <fieldset className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
          <legend className="sr-only">{field.label}</legend>
          {(field.options.length ? field.options : ["Option"]).map((option, index) => (
            <label key={`${option}-${index}`} className="flex cursor-pointer items-center gap-2 text-sm text-foreground-700">
              <input
                type="radio"
                name={field.id}
                value={option}
                disabled={disabled}
                required={field.required}
                defaultChecked={field.defaultValue === option}
                className="h-4 w-4 accent-primary-500"
              />
              {option}
            </label>
          ))}
        </fieldset>
      ) : field.type === "Checkbox" ? (
        field.options.length === 0 ? (
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground-700">
            <input
              type="checkbox"
              name={field.id}
              value="true"
              disabled={disabled}
              required={field.required}
              defaultChecked={field.defaultValue === "true"}
              className="h-4 w-4 accent-primary-500"
            />
            <span>{field.label || field.help || "Yes"}</span>
          </label>
        ) : (
          <fieldset className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
            <legend className={labelClass}>
              {field.label || "Options"}
              {field.required ? <span className="text-primary-600"> *</span> : null}
            </legend>
            {field.options.map((option, index) => (
              <label key={`${option}-${index}`} className="flex cursor-pointer items-start gap-2 text-sm text-foreground-700">
                <input
                  type="checkbox"
                  name={`${field.id}[]`}
                  value={option}
                  disabled={disabled}
                  defaultChecked={field.defaultValue === option}
                  className="mt-0.5 h-4 w-4 accent-primary-500"
                />
                <span className="leading-snug">{option}</span>
              </label>
            ))}
          </fieldset>
        )
      ) : field.type === "Textarea" ? (
        <textarea
          id={inputId}
          name={field.id}
          rows={field.rows ?? 4}
          maxLength={field.maxLength}
          disabled={disabled}
          required={field.required}
          placeholder={field.placeholder}
          className={inputClass}
        />
      ) : field.type === "Number" ? (
        <input
          id={inputId}
          name={field.id}
          type="number"
          min={field.min || undefined}
          max={field.max || undefined}
          step={field.step || undefined}
          disabled={disabled}
          required={field.required}
          placeholder={field.placeholder}
          className={inputClass}
        />
      ) : field.type === "Date" ? (
        <input
          id={inputId}
          name={field.id}
          type="date"
          min={field.min || undefined}
          max={field.max || undefined}
          disabled={disabled}
          required={field.required}
          className={inputClass}
        />
      ) : field.type === "File Upload" ? (
        <input
          id={inputId}
          name={field.id}
          type="file"
          accept={acceptAttribute(field.fileTypes)}
          disabled={disabled}
          required={field.required}
          className="w-full rounded-md border border-dashed border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-700 file:mr-3 file:rounded-md file:border-0 file:bg-primary-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-700"
        />
      ) : (
        <input
          id={inputId}
          name={field.id}
          type={field.type === "Email" ? "email" : field.type === "Phone" ? "tel" : "text"}
          maxLength={field.maxLength}
          disabled={disabled}
          required={field.required}
          placeholder={field.placeholder}
          className={inputClass}
        />
      )}

      {field.help && field.type !== "Checkbox" ? (
        <p className="mt-1 text-xs text-foreground-400">{field.help}</p>
      ) : null}
      {field.type === "File Upload" && field.maxSizeMb ? (
        <p className="mt-1 text-xs text-foreground-400">Maximum file size {field.maxSizeMb} MB.</p>
      ) : null}
    </div>
  );
}
