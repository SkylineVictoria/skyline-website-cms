/**
 * The address search used by the student application form and by staff onboarding. It is the shared AddressAutocomplete; this
 * module keeps the path both pages import from.
 */
export { default } from "@/components/shared/application-form/AddressAutocomplete";
export type { AddressLookup, AddressPick, AddressSearchFn } from "@/components/shared/application-form/AddressAutocomplete";
