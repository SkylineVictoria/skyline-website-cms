import { baseFieldClass, isConditionMet, isFieldFilled, sectionHeading, sectionIcon, todayIso } from "./applicationFieldHelpers";
import type { AppField, FieldCondition } from "@/data/applicationForms";

export function ApplicationFieldControl({
  field,
  formId,
  value,
  locked,
}: {
  field: AppField;
  formId: string;
  value?: string;
  /** Renders the field read-only (used for auto-filled agency/agent details). */
  locked?: boolean;
}) {
  const id = `${formId}-${field.name}`;

  if (field.type === "static") {
    return (
      <p className="rounded-md border border-background-200 bg-background-100 px-4 py-3 text-xs font-semibold uppercase leading-relaxed tracking-wide text-foreground-700">
        {field.description}
      </p>
    );
  }

  if (field.type === "radio") {
    return (
      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        {(field.options ?? []).map((option) => (
          <label key={option} className="flex cursor-pointer items-center gap-2 text-sm text-foreground-700">
            <input
              type="radio"
              name={field.name}
              value={option}
              required={field.required && !locked}
              disabled={locked}
              className="h-4 w-4 accent-primary-500"
            />
            {option}
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "checkbox") {
    return (
      <div className="flex flex-wrap gap-x-6 gap-y-2 pt-1">
        {(field.options ?? []).map((option) => (
          <label key={option} className="flex cursor-pointer items-start gap-2 text-sm text-foreground-700">
            <input
              type="checkbox"
              name={`${field.name}[]`}
              value={option}
              disabled={locked}
              className="mt-0.5 h-4 w-4 accent-primary-500"
            />
            <span className="leading-snug">{option}</span>
          </label>
        ))}
      </div>
    );
  }

  if (field.type === "textarea") {
    return (
      <textarea
        id={id}
        name={field.name}
        rows={4}
        maxLength={500}
        required={field.required && !locked}
        readOnly={locked}
        placeholder={field.placeholder}
        defaultValue={value}
        className={`${baseFieldClass}${locked ? " bg-background-100 text-foreground-600" : ""}`}
      />
    );
  }

  if (field.type === "select") {
    return (
      <select
        id={id}
        name={field.name}
        required={field.required && !locked}
        disabled={locked}
        defaultValue={value ?? ""}
        className={`${baseFieldClass}${locked ? " bg-background-100 text-foreground-600" : ""}`}
      >
        <option value="" disabled>
          {field.placeholder ?? "Select"}
        </option>
        {(field.options ?? []).map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === "file") {
    return (
      <input
        id={id}
        name={field.name}
        type="file"
        accept=".jpg,.jpeg,.gif,.png,.pdf"
        multiple={field.multiple}
        disabled={locked}
        className="w-full cursor-pointer rounded-md border border-dashed border-background-300 bg-background-50 px-3.5 py-2.5 text-sm text-foreground-700 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-100 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-700"
      />
    );
  }

  if (field.type === "table") {
    const headers = field.headers ?? [];
    const rows = field.rows ?? [];
    return (
      <div className="overflow-x-auto rounded-md border border-background-200">
        <table className="w-full border-collapse text-left text-xs">
          <thead className="bg-background-100 text-foreground-700">
            <tr>
              {headers.map((header) => (
                <th key={header} className="border-b border-background-200 px-3 py-2 font-semibold">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${row[0] ?? "row"}-${rowIndex}`} className="border-b border-background-200 last:border-b-0">
                {row.map((cell, cellIndex) => (
                  <td key={`${cell}-${cellIndex}`} className="px-3 py-2 text-foreground-700">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <input
      id={id}
      name={field.name}
      type={field.type}
      required={field.required && !locked}
      readOnly={locked}
      placeholder={field.placeholder}
      defaultValue={value ?? (field.defaultToday ? todayIso() : undefined)}
      className={`${baseFieldClass}${locked ? " bg-background-100 text-foreground-600" : ""}`}
    />
  );
}