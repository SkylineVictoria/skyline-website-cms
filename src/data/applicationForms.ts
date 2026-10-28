import { registeredAgentsPage } from "@/data/pages";
import { COUNTRY_OPTIONS } from "@/pages/agency/lib/countryOptions";

export type AppFieldType =
  | "text"
  | "email"
  | "tel"
  | "date"
  | "textarea"
  | "select"
  | "radio"
  | "checkbox"
  | "file"
  | "terms"
  | "static"
  | "table";

export type FieldCondition = { field: string; equals: string[] };

export type AppScanType = "passport" | "english" | "licence";

export type AppScan = {
  type: AppScanType;
  /** Name of an existing upload field the scanner should read from. */
  source?: string;
  /** Name of an existing upload field the chosen file should also be copied into. */
  target?: string;
};

export type AppField = {
  name: string;
  label: string;
  type: AppFieldType;
  required?: boolean;
  options?: string[];
  placeholder?: string;
  /** Special input behaviour: a year dropdown, a USI (10 characters) or a phone number with country code. */
  format?: "year" | "usi" | "phone";
  description?: string;
  full?: boolean;
  showIf?: FieldCondition;
  headers?: string[];
  rows?: string[][];
  defaultToday?: boolean;
  /** File fields only: allow the applicant to attach more than one file. */
  multiple?: boolean;
};

export type AppSection = {
  title?: string;
  description?: string;
  fields: AppField[];
  scans?: AppScan[];
  showIf?: FieldCondition;
};

export const countries: string[] = [...COUNTRY_OPTIONS];

const registeredAgentTable = registeredAgentsPage.blocks.find((block) => block.type === "table");

export const registeredAgentNames: string[] =
  registeredAgentTable && registeredAgentTable.type === "table"
    ? registeredAgentTable.rows.map((row) => row[0])
    : [];

export const enrolSections: AppSection[] = [
  {
    title: "1. PERSONAL DETAILS & PASSPORT",
    description:
      "Attach a clear photo of your passport biodata page — your name, date of birth, passport number, expiry and nationality are read and filled in automatically the moment you add the file. Everything is read on your device (nothing is uploaded), and every field stays editable afterwards.",
    fields: [
      {
        name: "passport_copy",
        label: "Passport Attachment (Biodata Page)",
        type: "file",
        required: true,
        full: true,
        description:
          "Attach a clear photo of your passport biodata page. The details below are read from this file automatically. Accepted file types: jpg, gif, png, pdf.",
      },
      {
        name: "title",
        label: "Title",
        type: "select",
        required: true,
        placeholder: "Select title",
        options: ["Mr", "Mrs", "Ms", "Miss", "Mx", "Dr", "Prof", "Rev", "Hon", "Other"],
      },
      { name: "first_name", label: "Given Name", type: "text", required: true },
      { name: "middle_name", label: "Middle Name (If Applicable)", type: "text" },
      { name: "last_name", label: "Surname", type: "text", required: true },
      { name: "dob", label: "Date of Birth", type: "date", required: true },
      {
        name: "gender",
        label: "Gender",
        type: "radio",
        required: true,
        options: ["Male", "Female", "Prefer not to say"],
      },
      { name: "mobile", label: "Mobile", type: "tel", format: "phone", required: true, placeholder: "412 345 678" },
      { name: "email", label: "Email", type: "email", required: true },
      { name: "confirm_email", label: "Confirm Email", type: "email", required: true },
      {
        name: "email_note",
        label: "",
        type: "static",
        full: true,
        description:
          "ALL COMMUNICATION WILL BE DONE VIA EMAIL, SO PLEASE PROVIDE AN EMAIL THAT WILL BE CHECKED REGULARLY.",
      },
      { name: "citizenship", label: "Country of Citizenship", type: "select", required: true, options: countries },
      { name: "nationality", label: "Nationality", type: "select", required: true, options: countries },
      { name: "birth_country", label: "Country of Birth", type: "select", required: true, options: countries },
      { name: "passport_number", label: "Passport Number", type: "text", required: true },
      { name: "passport_expiry", label: "Passport Expiry Date", type: "date", required: true },
    ],
    scans: [{ type: "passport", source: "passport_copy" }],
  },
  {
    title: "2. ADDRESS",
    scans: [{ type: "licence" }],
    fields: [
      {
        name: "address_type",
        label: "Address Type",
        type: "radio",
        required: true,
        full: true,
        options: ["Australian Address", "Overseas Address"],
      },
      {
        name: "au_street",
        label: "Street Address",
        type: "text",
        required: true,
        full: true,
        showIf: { field: "address_type", equals: ["Australian Address"] },
      },
      { name: "au_line2", label: "Address Line 2", type: "text", showIf: { field: "address_type", equals: ["Australian Address"] } },
      { name: "au_suburb", label: "Suburb", type: "text", required: true, showIf: { field: "address_type", equals: ["Australian Address"] } },
      { name: "au_state", label: "State", type: "text", required: true, showIf: { field: "address_type", equals: ["Australian Address"] } },
      { name: "au_zip", label: "ZIP / Postal Code", type: "text", required: true, showIf: { field: "address_type", equals: ["Australian Address"] } },
      {
        name: "au_country",
        label: "Country",
        type: "select",
        required: true,
        options: countries,
        showIf: { field: "address_type", equals: ["Australian Address"] },
      },
      {
        name: "ov_street",
        label: "Address",
        type: "text",
        required: true,
        full: true,
        showIf: { field: "address_type", equals: ["Overseas Address"] },
      },
      { name: "ov_line2", label: "Address Line 2", type: "text", showIf: { field: "address_type", equals: ["Overseas Address"] } },
      { name: "ov_suburb", label: "Suburb", type: "text", required: true, showIf: { field: "address_type", equals: ["Overseas Address"] } },
      { name: "ov_state", label: "State / Territory", type: "text", required: true, showIf: { field: "address_type", equals: ["Overseas Address"] } },
      { name: "ov_zip", label: "ZIP / Postal Code", type: "text", required: true, showIf: { field: "address_type", equals: ["Overseas Address"] } },
      {
        name: "ov_country",
        label: "Country",
        type: "select",
        required: true,
        options: countries,
        showIf: { field: "address_type", equals: ["Overseas Address"] },
      },
      {
        name: "address_note",
        label: "",
        type: "static",
        full: true,
        description:
          "PLEASE NOTIFY SKYLINE INSTITUTE OF TECHNOLOGY OF ANY CHANGES OF ADDRESS OR CONTACT DETAILS WHILE YOU ARE ENROLLED.",
      },
    ],
  },
  {
    title: "VISA, ENGLISH & AGENT DETAILS",
    scans: [{ type: "english", source: "english_upload" }],
    fields: [
      {
        name: "holds_visa",
        label: "Do you currently hold a valid Australian visa?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      {
        name: "visa_copy",
        label: "Visa Documents",
        type: "file",
        full: true,
        multiple: true,
        showIf: { field: "holds_visa", equals: ["Yes"] },
        description: "Optional. Attach visa grant letters, VEVO screenshots, or other visa-related documents. Multiple files allowed.",
      },
      { name: "visa_subclass", label: "Visa Subclass", type: "text", showIf: { field: "holds_visa", equals: ["Yes"] } },
      { name: "visa_grant_date", label: "Visa Grant Date", type: "date", showIf: { field: "holds_visa", equals: ["Yes"] } },
      { name: "visa_stay_until", label: "Visa Stay-until / Expiry Date", type: "date", showIf: { field: "holds_visa", equals: ["Yes"] } },
      { name: "visa_grant_number", label: "Visa Grant Number", type: "text", showIf: { field: "holds_visa", equals: ["Yes"] } },
      {
        name: "english_type",
        label: "English Assessment Type",
        type: "select",
        placeholder: "Select",
        options: ["IELTS Academic", "IELTS General Training", "PTE Academic", "TOEFL iBT", "Cambridge English", "Others (Please Specify)"],
      },
      { name: "english_score", label: "Score (Individual & Overall)", type: "text" },
      {
        name: "english_table",
        label: "English Score Requirements (Reference)",
        type: "table",
        full: true,
        headers: ["Assessment Type", "Overall", "L", "R", "W", "S"],
        rows: [
          ["IELTS", "6.0", "5.5", "5.5", "5.5", "5.5"],
          ["PTE", "50", "42", "42", "42", "42"],
          ["TOEFL iBT", "60", "12", "13", "18", "16"],
        ],
      },
      { name: "english_date", label: "Date Achieved", type: "date" },
      {
        name: "english_upload",
        label: "Upload English Results",
        type: "file",
        full: true,
        description: "Accepted file types: jpg, gif, png, pdf.",
      },
      {
        name: "via_agent",
        label: "Is your application submitted through an agent?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      {
        name: "agent_agency",
        label: "Agent / Agency Name",
        type: "select",
        required: true,
        full: true,
        placeholder: "Select your agent",
        options: [...registeredAgentNames, "Other"],
        showIf: { field: "via_agent", equals: ["Yes"] },
      },
      {
        name: "agent_contact_name",
        label: "Agent Contact Person",
        type: "text",
        showIf: { field: "via_agent", equals: ["Yes"] },
      },
      {
        name: "agent_email",
        label: "Agent Email",
        type: "email",
        showIf: { field: "via_agent", equals: ["Yes"] },
      },
      {
        name: "agent_phone",
        label: "Agent Contact Number",
        type: "tel",
        format: "phone",
        placeholder: "Optional",
        showIf: { field: "via_agent", equals: ["Yes"] },
      },
    ],
  },
  {
    title: "4. STUDENT IDENTIFIER (AVETMISS)",
    fields: [
      {
        name: "atsi",
        label: "Are you of Aboriginal or Torres Strait Islander origin?",
        type: "radio",
        required: true,
        full: true,
        options: ["No", "Yes, Aboriginal", "Yes, Torres Strait Islander", "Yes, Aboriginal and Torres Strait Islander"],
      },
      {
        name: "employment",
        label: "Employment Status",
        type: "select",
        required: true,
        full: true,
        placeholder: "Select",
        options: [
          "Full-Time Employee - 01",
          "Part-Time Employee - 02",
          "Self-Employment Not Employing Others - 03",
          "Self employed - employing others - 04",
          "Employed - Unpaid Worker in Family Business - 05",
          "Unemployed - Seeking Full-Time Work - 06",
          "Unemployed - Seeking Part-Time Work - 07",
          "Not Employed - Not Seeking Employment - 08",
        ],
      },
      {
        name: "language_home",
        label: "Language Spoken at Home",
        type: "select",
        required: true,
        full: true,
        placeholder: "Select",
        options: ["No, English only - 1201", "Yes, language other than English"],
      },
      {
        name: "secondary_enrolled",
        label: "Are you still enrolled in secondary or senior secondary education?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      {
        name: "school_level",
        label: "Highest Completed School Level",
        type: "select",
        required: true,
        placeholder: "Select",
        options: [
          "Year 12 or equivalent - 12",
          "Year 11 or equivalent - 11",
          "Year 10 or equivalent - 10",
          "Year 9 or equivalent - 09",
          "Year 8 or below - 08",
          "Never attended school - 02",
        ],
      },
      { name: "year_completed", label: "Year Completed", type: "text", placeholder: "Select year" },
      {
        name: "prior_ed",
        label: "Have you successfully completed any prior education?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No", "Not specified"],
      },
      {
        name: "disability",
        label: "Do you have any disability that may affect your participation in the course?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No", "Not specified"],
      },
    ],
  },
  {
    title: "4a. ACADEMIC DOCUMENTS",
    fields: [
      {
        name: "academic_upload",
        label: "Academic Records and Qualifications",
        type: "file",
        full: true,
        multiple: true,
        description:
          "Optional. Upload certificates, transcripts, or other academic documents (from year 10 onwards). You may attach multiple files.",
      },
      {
        name: "academic_institution",
        label: "Institution / School",
        type: "text",
        description: "Read from your marksheet — edit if needed.",
      },
      {
        name: "academic_qualification",
        label: "Qualification / Award",
        type: "text",
        description: "Read from your marksheet — edit if needed.",
      },
      {
        name: "academic_year",
        label: "Year Completed",
        type: "select",
        format: "year",
        placeholder: "Select year",
        description: "Read from your marksheet — edit if needed.",
      },
    ],
  },
  {
    title: "5. UNIQUE STUDENT IDENTIFIER (USI)",
    fields: [
      {
        name: "usi_note",
        label: "",
        type: "static",
        full: true,
        description:
          "A USI IS REQUIRED FOR NATIONALLY RECOGNISED TRAINING. APPLY AT USI.GOV.AU IF YOU DO NOT HAVE ONE.",
      },
      { name: "has_usi", label: "Do you already have a USI?", type: "radio", required: true, full: true, options: ["Yes", "No"] },
      {
        name: "usi_number",
        label: "USI Number",
        type: "text",
        format: "usi",
        required: true,
        full: true,
        placeholder: "Enter your 10-character USI",
        showIf: { field: "has_usi", equals: ["Yes"] },
      },
      {
        name: "usi_consent",
        label: "USI Consent",
        type: "checkbox",
        full: true,
        options: [
          "I consent to SLIT using/providing my USI for enrolment, reporting and verification purposes where required.",
        ],
      },
    ],
  },
  {
    title: "6. EMERGENCY CONTACT",
    fields: [
      { name: "ec_name", label: "Full Name", type: "text", required: true, full: true },
      { name: "ec_relationship", label: "Relationship to You", type: "text" },
      { name: "ec_email", label: "Email", type: "email" },
      { name: "ec_phone", label: "Contact Number", type: "tel", format: "phone", required: true, placeholder: "412 345 678" },
      {
        name: "ec_in_au",
        label: "Is your emergency contact in Australia?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      {
        name: "ec_street",
        label: "Emergency Contact Street Address",
        type: "text",
        full: true,
        description: "Optional. Where your emergency contact can be reached.",
      },
      { name: "ec_line2", label: "Address Line 2", type: "text" },
      { name: "ec_suburb", label: "Suburb", type: "text" },
      { name: "ec_state", label: "State / Province / Region", type: "text" },
      { name: "ec_zip", label: "ZIP / Postal Code", type: "text" },
      { name: "ec_country", label: "Country", type: "select", options: countries },
    ],
  },
  {
    title: "7. COURSE INFORMATION",
    fields: [
      {
        name: "courses_of_interest",
        label: "Course Name (Course Code and Title)",
        type: "checkbox",
        required: true,
        full: true,
        description: "Tick one or more courses below. Each option shows course code and name.",
        options: [
          "RII60520_104 - Advanced Diploma of Civil Construction Design (104 weeks)",
          "RII60520 - Advanced Diploma of Civil Construction Design (52 Weeks)",
          "ICT60220 - Advanced Diploma of Information Technology",
          "MSF30322 - Certificate III in Cabinet Making and Timber Technology",
          "CPC30220 - Certificate III in Carpentry",
          "MSF30422 - Certificate III in Glass and Glazing",
          "AUR30620 - Certificate III in Light Vehicle Mechanical Technology",
          "CPC30620 - Certificate III in Painting and Decorating",
          "AUR40216 - Certificate IV in Automotive Mechanical Diagnosis",
          "CPC50220 - Diploma of Building and Construction (Building)",
          "BSB50120 - Diploma of Business",
          "RII50520 - Diploma of Civil Construction Design",
          "BSB80120 - Graduate Diploma of Management (Learning)",
        ],
      },
      { name: "preferred_intake", label: "Preferred Intake", type: "text", required: true, full: true, description: "MM/YYYY" },
      {
        name: "intake_note",
        label: "",
        type: "static",
        full: true,
        description:
          "PLEASE CONTACT THE ADMISSIONS DEPARTMENT FOR INTAKE DATES, PRICES AND COURSE INFORMATION. SLIT CANNOT GUARANTEE THE AVAILABILITY OF YOUR SELECTED SCHEDULE.",
      },
    ],
  },
  {
    title: "8. STUDY REASON",
    fields: [
      {
        name: "study_reason",
        label: "Main reason for undertaking this course",
        type: "radio",
        required: true,
        full: true,
        options: [
          "To get a job - 01",
          "To develop my existing business - 02",
          "To start my own business - 03",
          "To try for a different career - 04",
          "To get a better job or promotion - 05",
          "It was a requirement of my job - 06",
          "I wanted extra skills for my job - 07",
          "To get into another course of study - 08",
          "For personal interest or self-development - 09",
          "To get skills for community/voluntary work - 10",
          "Other reasons - 11",
        ],
      },
    ],
  },
  {
    title: "9. COURSE CREDIT",
    fields: [
      {
        name: "rpl",
        label: "Do you wish to apply for Recognition of Prior Learning (RPL) / Credit Transfer (CT)?",
        type: "radio",
        required: true,
        full: true,
        options: ["No", "Yes"],
      },
      {
        name: "credit_upload",
        label: "Upload Supporting Documents for RPL / Credit Transfer",
        type: "file",
        full: true,
        multiple: true,
        showIf: { field: "rpl", equals: ["Yes"] },
        description:
          "Attach your prior qualifications, transcripts or statements of attainment. Multiple files allowed. Accepted types: jpg, gif, png, pdf.",
      },
    ],
  },
  {
    title: "10. OSHC / HEALTH INSURANCE",
    fields: [
      {
        name: "oshc_docs",
        label: "Health Insurance Documents",
        type: "file",
        full: true,
        multiple: true,
        description: "Optional. Attach OSHC or other health insurance certificates (multiple files allowed).",
      },
      {
        name: "oshc_require",
        label: "Do you require SLIT to obtain Overseas Student Health Cover on your behalf?",
        type: "select",
        required: true,
        full: true,
        placeholder: "Select",
        options: ["Yes", "No", "Already Have"],
      },
      {
        name: "oshc_start_date",
        label: "Preferred OSHC Cover Start Date",
        type: "date",
        full: true,
        showIf: { field: "oshc_require", equals: ["Yes"] },
        description: "SLIT will arrange your cover with the recommended provider. Provide the date you want cover to begin.",
      },
      {
        name: "oshc_self_confirm",
        label: "OSHC Confirmation",
        type: "checkbox",
        full: true,
        showIf: { field: "oshc_require", equals: ["No"] },
        options: [
          "I understand I must arrange and maintain my own Overseas Student Health Cover for the full duration of my student visa and provide proof when requested.",
        ],
      },
      {
        name: "oshc_provider",
        label: "OSHC Provider",
        type: "text",
        showIf: { field: "oshc_require", equals: ["Already Have"] },
      },
      {
        name: "oshc_policy_number",
        label: "Policy / Membership Number",
        type: "text",
        showIf: { field: "oshc_require", equals: ["Already Have"] },
      },
      {
        name: "oshc_expiry",
        label: "Policy Expiry Date",
        type: "date",
        showIf: { field: "oshc_require", equals: ["Already Have"] },
      },
    ],
  },
  {
    title: "11. HOW DID YOU HEAR ABOUT SLIT?",
    fields: [
      {
        name: "hear_about",
        label: "Source",
        type: "select",
        required: true,
        full: true,
        placeholder: "Select",
        options: ["SLIT Website", "Agent", "SLIT Student", "SLIT Staff Member", "Family/Friend/Member", "Others"],
      },
    ],
  },
  {
    title: "12. APPLICATION CHECKLIST",
    fields: [
      {
        name: "checklist_note",
        label: "",
        type: "static",
        full: true,
        description:
          "ATTACH YOUR PASSPORT IN THE ‘PERSONAL DETAILS & PASSPORT’ PANEL AND YOUR ENGLISH TEST RESULT IN THE ‘VISA, ENGLISH & AGENT DETAILS’ PANEL. TRANSCRIPT UPLOAD IS ONLY REQUIRED IN ‘COURSE CREDIT’ IF YOU APPLY FOR RPL / CREDIT TRANSFER. TICK EACH ITEM BELOW THAT APPLIES.",
      },
      {
        name: "checklist",
        label: "Application Checklist",
        type: "checkbox",
        required: true,
        full: true,
        options: [
          "Complete all sections of the application form",
          "Provide details if you already have a student visa and/or OSHC",
        ],
      },
    ],
  },
  {
    title: "13. STUDENT DECLARATION",
    description: "You must read SLIT Terms and condition",
    fields: [
      {
        name: "declaration",
        label: "By submitting this 'Student Application for Enrolment' the applicant acknowledges the following:",
        type: "terms",
        full: true,
        options: [
          "I declare that the information submitted with this application is true and complete.",
          "I acknowledge that failure to provide any document or disclose my academic record may result in SLIT revoking an offer or terminating my studies at any stage.",
          "I authorise SLIT to seek verification of my academic and professional qualifications, and work experience. I understand that SLIT reserves the right to inform other tertiary institutions and regulatory agencies and right to cancel the enrolment if any of the material presented to support my application is found to be false",
          "I understand that at the time of enrolment I will be required to supply originals of all documents used to support this application",
          "I acknowledge that SLIT reserves the right to alter any course, subject, admission requirement or fee without prior notice.",
          "I understand that the personal information I have provided may be released to government agencies as required by law.",
          "I further understand that it may be disclosed to third parties for the purpose of this application. I also undertake to update about any address / contact detail change within 5 working days in writing to the college.",
          "I acknowledge that I have read and understand the description of the courses(s) that I am applying for.",
          "I agree to pay the applicable tuition fees prior to COE Issuance, term commencement and subsequent instalments of nominated studies set out on the letter of offer and I agree to be personally liable to the debt arising from fees owing. I understand that SLIT may seek the services of external debt collection agencies for the collection purpose. I will be liable to pay for any legal or linked charges for any such agencies",
          "I have read and understand SLIT fees and refund policy and requirements as set out within the Student Handbook.",
          "I authorised SLIT to access the Australian immigration Visa Entitlements Verification Online (VEVO) system at any time to obtain information on my visa status.",
          "I declare that I am a genuine temporary entrant and genuine student and that I have read and understood conditions relating to requirements outlined on https://www.homeaffairs.gov.au",
          "I am aware of the tuition and living costs of my stay in Australia and have the financial capacity to meet such costs for the duration of my course. I will make timely payments of any fees or associated costs.",
          "I have read and understand the description of the ESOS framework made available at: https://internationaleducation.gov.au/regulatory-information/pages/regulatoryinformation.aspx",
          "I declare that the information provided in this application and the documentation supporting it is true and complete",
        ],
      },
      {
        name: "declaration_name",
        label: "Full Name of The Person Who Made the Declaration",
        type: "text",
        required: true,
        full: true,
        description: "Name only",
      },
      {
        name: "digital_signature",
        label: "Digital Signature",
        type: "text",
        required: true,
        full: true,
        description: "Type your full name to sign.",
      },
      { name: "declaration_date", label: "Declaration Date", type: "date", required: true, full: true, defaultToday: true },
    ],
  },
];

export const agentSections: AppSection[] = [
  {
    title: "COMPANY",
    fields: [
      { name: "agency_legal_name", label: "Agent/Agency (Legal Name)", type: "text" },
      { name: "trading_name", label: "Trading Name", type: "text" },
      { name: "business_number", label: "Business/Mara/ Registration Number:", type: "text" },
      { name: "abn", label: "ABN/ACN", type: "text" },
    ],
  },
  {
    title: "CONTACT DETAILS",
    fields: [
      { name: "title", label: "Title", type: "select", options: ["Dr.", "Miss", "Mr.", "Mrs.", "Ms.", "Prof.", "Rev."] },
      { name: "given_name", label: "Given Name", type: "text" },
      { name: "family_name", label: "Family Name", type: "text" },
      { name: "position_person", label: "Possition", type: "text" },
      { name: "email", label: "Email", type: "email" },
      { name: "phone", label: "Phone", type: "tel", placeholder: "(999) 999-9999" },
      { name: "street", label: "Street Address", type: "text", full: true },
      { name: "line2", label: "Address Line 2", type: "text", full: true },
      { name: "city", label: "City", type: "text" },
      { name: "state", label: "State / Province / Region", type: "text" },
      { name: "zip", label: "ZIP / Postal Code", type: "text" },
      { name: "country", label: "Country", type: "select", options: countries },
    ],
  },
  {
    title: "AGENCY PROFILE",
    fields: [
      { name: "years_agent", label: "Years as an education agent", type: "text", description: "Number of years" },
      {
        name: "litigation",
        label:
          "Has the company or any individual within the company ever been involved in past, pending, threatened or potential litigation, arbitration, administrative actions or other disputes?",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      {
        name: "eatc",
        label: "Have you or your staff completed the EATC Training (PIER Online)? http://www.pieronline.org/eatc/",
        type: "radio",
        required: true,
        full: true,
        options: ["Yes", "No"],
      },
      { name: "litigation_details", label: "If yes, please provide details:", type: "text", full: true, showIf: { field: "litigation", equals: ["Yes"] } },
      { name: "students_recruited", label: "No. of students recruited to Australian Institutions each year?", type: "text", full: true },
      { name: "popular_courses", label: "Please list the popular courses amongst your students:", type: "text", full: true },
      { name: "promote", label: "How do you intend to promote SKYLINE INSTITUTE OF TECHNOLOGY (SLIT) in your office?", type: "text", full: true },
      { name: "intend_recruit", label: "How many students do you intend to recruit to SLIT each year?", type: "text", full: true },
      { name: "staff_count", label: "Numbers of staff in your office:", type: "text", full: true },
      { name: "associations", label: "List member of Associations:", type: "text", full: true },
      { name: "services", label: "Services provided to students:", type: "text", full: true },
      { name: "offices", label: "Number of offices (locations):", type: "text", full: true, description: "(If you have other office(s), please send email list of offices to marketing@iti.edu.au if more than one)" },
      { name: "other_countries", label: "Do you recruit students to countries other than Australia, If yes, please list below", type: "text", full: true },
      { name: "represent_institutions", label: "Do you represent educational institutions in Australia? If yes, please list below:", type: "text", full: true },
    ],
  },
  {
    title: "Reference 1",
    fields: [
      { name: "ref1_name", label: "Contact Name", type: "text" },
      { name: "ref1_org", label: "Organisation", type: "text" },
      { name: "ref1_position", label: "Position", type: "text" },
      { name: "ref1_email", label: "Email", type: "email" },
      { name: "ref1_phone", label: "Phone", type: "tel", placeholder: "(999) 999-9999" },
      { name: "ref1_street", label: "Street Address", type: "text", full: true },
      { name: "ref1_line2", label: "Address Line 2", type: "text", full: true },
      { name: "ref1_city", label: "City", type: "text" },
      { name: "ref1_state", label: "State / Province / Region", type: "text" },
      { name: "ref1_zip", label: "ZIP / Postal Code", type: "text" },
      { name: "ref1_country", label: "Country", type: "select", options: countries },
    ],
  },
  {
    title: "Reference 2",
    fields: [
      { name: "ref2_name", label: "Contact Name", type: "text" },
      { name: "ref2_org", label: "Organisation", type: "text" },
      { name: "ref2_position", label: "Position", type: "text" },
      { name: "ref2_email", label: "Email", type: "email" },
      { name: "ref2_phone", label: "Phone", type: "tel", placeholder: "(999) 999-9999" },
      { name: "ref2_street", label: "Street Address", type: "text", full: true },
      { name: "ref2_line2", label: "Address Line 2", type: "text", full: true },
      { name: "ref2_city", label: "City", type: "text" },
      { name: "ref2_state", label: "State / Province / Region", type: "text" },
      { name: "ref2_zip", label: "ZIP / Postal Code", type: "text" },
      { name: "ref2_country", label: "Country", type: "select", options: countries },
    ],
  },
  {
    title: "ATTACHMENTS",
    fields: [
      { name: "org_chart", label: "Organisational Chart: (If available, please attach)", type: "file", full: true },
      { name: "business_profile", label: "Business Profile/Strategic Plan (If available, please attach)", type: "file", full: true },
    ],
  },
  {
    title: "Consent",
    fields: [
      { name: "consent", label: "I agree to the privacy policy.", type: "checkbox", required: true, full: true, options: ["I agree to the privacy policy."] },
      { name: "declaration_name", label: "FULL NAME OF THE PERSON AND ROLE", type: "text", required: true, full: true },
      { name: "declaration_date", label: "Date", type: "date", required: true, full: true },
    ],
  },
];
