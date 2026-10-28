import { Field, Select, TextInput } from "@/pages/admin/components/ui";
import type { AgencyFormErrors, AgencyFormState } from "@/pages/admin/lib/agencyForm";

/** The agency fields, shared by Add agency and the agency Details tab. */
export default function AgencyForm({ value, errors, disabled = false, onChange }: { value: AgencyFormState; errors: AgencyFormErrors; disabled?: boolean; onChange: (patch: Partial<AgencyFormState>) => void }) {
  const field = (key: keyof AgencyFormState, label: string, hint: string, props: { required?: boolean; type?: string; placeholder?: string } = {}) => (
    <div>
      <Field label={label} hint={errors[key] ? undefined : hint} required={props.required}>
        <TextInput disabled={disabled} type={props.type} placeholder={props.placeholder} value={value[key]} aria-invalid={Boolean(errors[key])} onChange={(e) => onChange({ [key]: e.target.value })} />
      </Field>
      {errors[key] ? <p role="alert" className="mt-1 text-xs font-medium text-red-700">{errors[key]}</p> : null}
    </div>
  );
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {field("name", "Agency name", "As it appears to staff and on applications.", { required: true })}
      {field("code", "Agency code", "A short unique code, for example GPE-001.", { required: true })}
      {field("businessEmail", "Contact email", "The agency’s main business email.", { required: true, type: "email" })}
      {field("phone", "Phone", "Australian numbers as 0412 345 678 or 02 9123 4567; otherwise start with + and the country code.", { placeholder: "0412 345 678" })}
      {field("primaryContact", "Primary contact", "The person at the agency we usually deal with.")}
      {field("registrationNumber", "Registration / ABN", "Optional.")}
      {field("country", "Country", "Where the agency is based.")}
      {field("address", "Address", "Optional street address.")}
      <div>
        <Field label="Status" hint="Inactive agencies cannot sign in or submit; their history is kept.">
          <Select disabled={disabled} value={value.status} onChange={(e) => onChange({ status: e.target.value === "Inactive" ? "Inactive" : "Active" })}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}
