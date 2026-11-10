import { WIZARD_INPUT, FieldError, WizardLabel, WizardTextField } from "@/components/shared/wizard/fields";
import { ADDRESS_LINE_MAX, AU_STATES, isAustralia, type Address, type AddressProblems } from "../../../../supabase/functions/_shared/validation/person";

/**
 * An address: street, line 2, suburb, state, postcode and country. For Australia the state is a list (ACT, NSW, …) and the
 * postcode is four digits; the rules are addressProblems() in the shared validation module.
 */
export default function AddressFields({ idPrefix, value, errors, onChange, testIdPrefix }: {
  idPrefix: string;
  value: Address;
  errors: AddressProblems;
  onChange: (field: keyof Address, value: string) => void;
  testIdPrefix?: string;
}) {
  const australian = isAustralia(value.country);
  const testId = (field: string) => (testIdPrefix ? `${testIdPrefix}${field}` : undefined);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <WizardTextField id={`${idPrefix}street`} name="address_street" label="Street address" value={value.street} error={errors.street} maxLength={ADDRESS_LINE_MAX}
          autoComplete="address-line1" testId={testId("address_street")} onChange={(v) => onChange("street", v)} />
      </div>
      <div className="sm:col-span-2">
        <WizardTextField id={`${idPrefix}line2`} name="address_line2" label="Address line 2" required={false} value={value.line2} error={errors.line2} maxLength={ADDRESS_LINE_MAX}
          autoComplete="address-line2" testId={testId("address_line2")} onChange={(v) => onChange("line2", v)} />
      </div>
      <WizardTextField id={`${idPrefix}suburb`} name="address_suburb" label="Suburb or city" value={value.suburb} error={errors.suburb} maxLength={ADDRESS_LINE_MAX}
        autoComplete="address-level2" testId={testId("address_suburb")} onChange={(v) => onChange("suburb", v)} />
      {australian ? (
        <div>
          <WizardLabel htmlFor={`${idPrefix}state`}>State or territory</WizardLabel>
          <select id={`${idPrefix}state`} name="address_state" value={value.state.toUpperCase()} aria-invalid={Boolean(errors.state)} className={WIZARD_INPUT}
            data-testid={testId("address_state")} onChange={(e) => onChange("state", e.target.value)}>
            <option value="">Select</option>
            {AU_STATES.map((state) => <option key={state} value={state}>{state}</option>)}
          </select>
          <FieldError text={errors.state} />
        </div>
      ) : (
        <WizardTextField id={`${idPrefix}state`} name="address_state" label="State or region" required={false} value={value.state} error={errors.state} maxLength={ADDRESS_LINE_MAX}
          autoComplete="address-level1" testId={testId("address_state")} onChange={(v) => onChange("state", v)} />
      )}
      <WizardTextField id={`${idPrefix}postcode`} name="address_postcode" label="Postcode" required={australian} value={value.postcode} error={errors.postcode}
        maxLength={australian ? 4 : 20} inputMode={australian ? "numeric" : undefined} autoComplete="postal-code" testId={testId("address_postcode")} onChange={(v) => onChange("postcode", v)} />
      <WizardTextField id={`${idPrefix}country`} name="address_country" label="Country" value={value.country} error={errors.country} maxLength={ADDRESS_LINE_MAX}
        autoComplete="country-name" testId={testId("address_country")} onChange={(v) => onChange("country", v)} />
    </div>
  );
}
