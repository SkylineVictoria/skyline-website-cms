import { foeCode, joinLocations, mapCricos, toBoolean, toInteger, toMoney, toText } from "./cricos.ts";

const assert = (ok: boolean, message = "Assertion failed") => { if (!ok) throw new Error(message); };
const same = (actual: unknown, expected: unknown) =>
  assert(JSON.stringify(actual) === JSON.stringify(expected), `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

Deno.test("fee strings become numbers", () => {
  same(toMoney("$15,000.00"), 15000);
  same(toMoney("$1,000.50"), 1000.5);
  same(toMoney("16000"), 16000);
  same(toMoney(" $ 0.00 "), 0);
  same(toMoney("POA"), null);
  same(toMoney(""), null);
  same(toMoney(null), null);
});

Deno.test("Yes/No become booleans and everything else null", () => {
  same(toBoolean("Yes"), true);
  same(toBoolean("No"), false);
  same(toBoolean(" yes "), true);
  same(toBoolean(""), null);
  same(toBoolean(null), null);
  same(toBoolean("Maybe"), null);
});

Deno.test("nulls and empty values stay null; integers parse", () => {
  same(toText(null), null);
  same(toText("   "), null);
  same(toText(66), "66");
  same(toInteger(66), 66);
  same(toInteger("360"), 360);
  same(toInteger(null), null);
  same(toInteger("n/a"), null);
});

Deno.test("Field of Education code is the part before ' - '", () => {
  same(foeCode("030503 - Vehicle Mechanics"), "030503");
  same(foeCode("03 - Engineering and Related Technologies"), "03");
  same(foeCode("Vehicle Mechanics"), null);
  same(foeCode(null), null);
});

const course = {
  "CRICOS Provider Code": "04114B", "Institution Name": "Indopacific Global Pty Ltd", "CRICOS Course Code": "112739C",
  "Course Name": "Certificate III in Light Vehicle Mechanical Technology", "VET National Code": "AUR30620", "Dual Qualification": "No",
  "Field of Education 1 Broad Field": "03 - Engineering and Related Technologies",
  "Field of Education 1 Narrow Field": "0305 - Automotive Engineering and Technology",
  "Field of Education 1 Detailed Field": "030503 - Vehicle Mechanics",
  "Field of Education 2 Broad Field": null, "Field of Education 2 Narrow Field": null, "Field of Education 2 Detailed Field": null,
  "Course Level": "Certificate III", "Foundation Studies": "No", "Work Component": "No", "Work Component Hours/Week": null,
  "Work Component Weeks": null, "Work Component Total Hours": null, "Course Language": "English", "Duration (Weeks)": 66,
  "Tuition Fee": "$15,000.00", "Non Tuition Fee": "$1,000.00", "Estimated Total Course Cost": "$16,000.00", "Expired": "No",
};
const institution = {
  "CRICOS Provider Code": "04114B", "Trading Name": "Skyline Institute of Technology", "Institution Name": "Indopacific Global Pty Ltd",
  "Institution Type": "Private", "Institution Capacity": "360", "Website": null, "Postal Address Line 1": "Level 8 310 King St",
  "Postal Address Line 2": null, "Postal Address Line 3": null, "Postal Address Line 4": null, "Postal Address City": "MELBOURNE",
  "Postal Address State": "VIC", "Postal Address Postcode": "3000",
};
const location = {
  "CRICOS Provider Code": "04114B", "Institution Name": "Indopacific Global Pty Ltd", "Location Name": "Skyline Institute of Technology",
  "Location Type": "Location owned and operated by provider", "Address Line 1": "Level 8 310 King St", "Address Line 2": null,
  "Address Line 3": null, "Address Line 4": null, "City": "Melbourne", "State": "VIC", "Postcode": "3000",
};
const courseLocation = { "CRICOS Provider Code": "04114B", "CRICOS Course Code": "112739C", "Location Name": "Skyline Institute of Technology", "Location City": "Melbourne", "Location State": "VIC" };

Deno.test("112739C maps every register field (acceptance data)", () => {
  const { fields, locations, warnings } = mapCricos({ courses: [course], institutions: [institution], locations: [location], courseLocations: [courseLocation] });
  same(fields.cricos_course_name, "Certificate III in Light Vehicle Mechanical Technology");
  same(fields.cricos_vet_national_code, "AUR30620");
  same(fields.cricos_duration_weeks, 66);
  same([fields.cricos_tuition_fee, fields.cricos_non_tuition_fee, fields.cricos_total_cost], [15000, 1000, 16000]);
  same([fields.cricos_foe1_detailed, fields.cricos_foe1_detailed_code, fields.cricos_foe1_broad_code], ["030503 - Vehicle Mechanics", "030503", "03"]);
  same([fields.cricos_foe2_broad, fields.cricos_foe2_broad_code], [null, null]);
  same([fields.cricos_dual_qualification, fields.cricos_has_work_component, fields.cricos_expired], [false, false, false]);
  same(fields.cricos_work_component_weeks, null);
  same([fields.institution_trading_name, fields.institution_name, fields.institution_type, fields.institution_capacity],
    ["Skyline Institute of Technology", "Indopacific Global Pty Ltd", "Private", 360]);
  same([fields.institution_postal_address_line_1, fields.institution_postal_city, fields.institution_postal_state, fields.institution_postal_postcode],
    ["Level 8 310 King St", "MELBOURNE", "VIC", "3000"]);
  same(locations.length, 1);
  same([locations[0].location_name, locations[0].city, locations[0].state, locations[0].postcode], ["Skyline Institute of Technology", "Melbourne", "VIC", "3000"]);
  same(warnings, []);
});

Deno.test("warnings: other provider, expired, no VET code", () => {
  const { warnings } = mapCricos({ courses: [{ ...course, "CRICOS Provider Code": "00001A", "Expired": "Yes", "VET National Code": null }], institutions: [], locations: [], courseLocations: [] });
  same(warnings.length, 3);
  assert(warnings[0].includes("00001A"));
});

Deno.test("an unmatched course location keeps its name, city and state", () => {
  same(joinLocations([{ "Location Name": "Other Campus", "Location City": "Sydney", "Location State": "NSW" }], [location]), [{
    location_name: "Other Campus", location_type: null, address_line_1: null, address_line_2: null, address_line_3: null,
    address_line_4: null, city: "Sydney", state: "NSW", postcode: null,
  }]);
});
