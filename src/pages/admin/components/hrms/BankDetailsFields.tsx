import { Field, TextInput } from "@/pages/admin/components/ui";
import type { EmployeeBank } from "@/lib/employeesApi";

/** The four bank fields (account name, BSB, account number, bank name), used by Add / Edit employee and the Bank details card. */
export default function BankDetailsFields({ value, problems, disabled, onChange }: {
  value: EmployeeBank; problems: Partial<Record<keyof EmployeeBank, string>>; disabled?: boolean; onChange: (next: EmployeeBank) => void;
}) {
  const field = (key: keyof Omit<EmployeeBank, "updatedAt">, label: string, props: Record<string, unknown>) => (
    <div>
      <Field label={label}>
        <TextInput value={value[key] ?? ""} disabled={disabled} aria-invalid={Boolean(problems[key])} data-testid={`bank-${key}`}
          onChange={(e) => onChange({ ...value, [key]: e.target.value })} autoComplete="off" {...props} />
      </Field>
      {problems[key] ? <p role="alert" className="mt-1 text-xs text-primary-700">{problems[key]}</p> : null}
    </div>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {field("accountName", "Account name", { maxLength: 100, placeholder: "As shown on the bank account" })}
      {field("bankName", "Bank", { maxLength: 100, placeholder: "e.g. Commonwealth Bank" })}
      {field("bsb", "BSB", { maxLength: 7, inputMode: "numeric", placeholder: "062-000" })}
      {field("accountNumber", "Account number", { maxLength: 12, inputMode: "numeric", placeholder: "12345678" })}
    </div>
  );
}
