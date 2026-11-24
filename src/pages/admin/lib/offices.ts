import { supabase } from "@/pages/admin/lib/supabase";
import { placeAddressLine, type PlaceDetails } from "../../../../supabase/functions/_shared/google-places";

/** Head office and branches of a business (agency_offices_get / agency_offices_set, 20261124101517). */
export interface OfficeLocation {
  label?: string; name?: string; street: string; suburb: string; state: string; postcode: string; country?: string;
  website?: string; phone?: string; placeId?: string; mapsUri?: string;
}
export const STATES = ["ACT", "NSW", "NT", "QLD", "SA", "TAS", "VIC", "WA"] as const;
export const EMPTY_OFFICE: OfficeLocation = { street: "", suburb: "", state: "", postcode: "", country: "Australia", phone: "" };
export const officeFromPlace = (p: PlaceDetails, label = ""): OfficeLocation => ({
  label, name: p.name, street: p.street, suburb: p.suburb, state: p.state, postcode: p.postcode, country: p.country || "Australia",
  website: p.website, phone: p.phone, placeId: p.placeId, mapsUri: p.mapsUri,
});
export const officeLine = (o: Pick<OfficeLocation, "street" | "suburb" | "state" | "postcode">) => placeAddressLine(o) || [o.suburb, o.state, o.postcode].filter(Boolean).join(" ");

const cleanOffice = (o: OfficeLocation) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === "string" ? v.trim() : v]).filter(([, v]) => v));
export const saveOffices = async (agencyId: string, head: OfficeLocation | null, branches: OfficeLocation[] | null) => {
  const { data, error } = await supabase.rpc("agency_offices_set", { p_agency: agencyId, p_head: head ? cleanOffice(head) : null,
    p_branches: branches ? branches.filter(b => b.street.trim() || b.suburb.trim()).map(cleanOffice) : null });
  if (error) throw new Error(error.message);
  return data as { head: OfficeLocation; branches: OfficeLocation[] };
};
