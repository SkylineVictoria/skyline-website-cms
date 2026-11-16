// One message template, three channels. A template has an email subject and one plain-text body with {{variables}}; the same body is
// used for email, SMS and WhatsApp. Rendering is pure and runtime-neutral so it can be tested and reused by any sender.

export const CHANNELS = ["email", "sms", "whatsapp"] as const;
export type Channel = (typeof CHANNELS)[number];
export const CHANNEL_LABELS: Record<Channel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export const TEMPLATE_CATEGORIES = [
  "Admissions", "Offer & CoE", "Documents", "Accounts & access", "Staff & HR", "Signing", "Support", "Bookings", "Assessments", "General",
] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface CommunicationTemplate {
  id: string;
  key: string;
  name: string;
  category: TemplateCategory;
  audience: string;
  description: string;
  subject: string;
  body: string;
  channels: Channel[];
  status: "active" | "archived";
  isSystem: boolean;
  updatedAt: string;
}

/** Variables offered in the editor, with the sample values used in previews. */
export const TEMPLATE_VARIABLES: { name: string; label: string; sample: string }[] = [
  { name: "first_name", label: "First name", sample: "Priya" },
  { name: "full_name", label: "Full name", sample: "Priya Sharma" },
  { name: "student_name", label: "Student name", sample: "Priya Sharma" },
  { name: "agent_name", label: "Agent name", sample: "Rahul Mehta" },
  { name: "agency_name", label: "Agency name", sample: "Global Study Partners" },
  { name: "institution", label: "Institution", sample: "Skyline Institute of Technology" },
  { name: "reference", label: "Application reference", sample: "SLIT-42000000" },
  { name: "status", label: "Status", sample: "Under review" },
  { name: "previous_status", label: "Previous status", sample: "Submitted" },
  { name: "course_name", label: "Course", sample: "Diploma of Information Technology" },
  { name: "intake_date", label: "Intake date", sample: "3 February 2027" },
  { name: "message", label: "Personal message", sample: "Please bring your passport on the first day." },
  { name: "link", label: "Link", sample: "https://skyline-website-cms.vercel.app/x/AbC123" },
  { name: "expiry_date", label: "Link expiry date", sample: "30 November 2026" },
  { name: "code", label: "Code", sample: "482913" },
  { name: "document_title", label: "Document title", sample: "Letter of offer" },
  { name: "documents_list", label: "Documents list", sample: "Passport (photo unclear)" },
  { name: "position", label: "Job title", sample: "Trainer and Assessor" },
  { name: "role", label: "Role", sample: "Agent" },
  { name: "email", label: "Email address", sample: "priya@example.com" },
  { name: "ticket_ref", label: "Ticket reference", sample: "TKT-1042" },
  { name: "ticket_subject", label: "Ticket subject", sample: "Cannot upload my transcript" },
  { name: "booking_type", label: "Booking type", sample: "Course advice session" },
  { name: "host_name", label: "Host name", sample: "Anita Singh" },
  { name: "booker_name", label: "Booker name", sample: "Priya Sharma" },
  { name: "date_time", label: "Date and time", sample: "Tue 24 Nov 2026, 10:00 am" },
  { name: "location", label: "Location", sample: "Level 2, 123 Collins St, Melbourne" },
  { name: "assessment_title", label: "Assessment", sample: "ICTICT418 Assessment 1" },
  { name: "due_date", label: "Due date", sample: "1 December 2026" },
  { name: "unit_name", label: "Unit", sample: "ICTICT418 Contribute to copyright, ethics and privacy in an IT environment" },
  { name: "outcome", label: "Outcome", sample: "Competent" },
  { name: "feedback", label: "Feedback", sample: "Well structured answers. Add one more example in Q3." },
  { name: "reason", label: "Reason", sample: "Applicant asked to change the start date." },
];
const SAMPLES: Record<string, string> = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.name, v.sample]));

const VARIABLE = /\{\{\s*([a-z][a-z0-9_]*)\s*\}\}/gi;

/** Variable names used in the given texts, in first-seen order, lower-cased. */
export function templateVariables(...texts: string[]): string[] {
  const seen: string[] = [];
  for (const text of texts) for (const m of (text ?? "").matchAll(VARIABLE)) { const n = m[1].toLowerCase(); if (!seen.includes(n)) seen.push(n); }
  return seen;
}

/** Replaces {{variables}} with values. Unknown variables stay visible as {{name}} so a missing value is noticed, never silently blank. */
export function renderTemplate(text: string, values: Record<string, string | null | undefined>): string {
  return (text ?? "").replace(VARIABLE, (whole, name: string) => {
    const v = values[name.toLowerCase()];
    return v === undefined || v === null || v === "" ? whole : String(v);
  });
}

/** The text a channel sends: email keeps the body; SMS drops simple *bold* / _italic_ marks; WhatsApp keeps them (it formats them). */
export function channelText(channel: Channel, body: string, values: Record<string, string | null | undefined> = SAMPLES): string {
  const text = renderTemplate(body, values).replace(/\r\n?/g, "\n").trim();
  if (channel === "sms") return text.replace(/\*([^*\n]+)\*/g, "$1").replace(/(^|\s)_([^_\n]+)_(?=\s|$|[.,!?])/g, "$1$2");
  return text;
}

export function sampleValues(): Record<string, string> { return { ...SAMPLES }; }

// GSM 03.38 basic + extension characters (extension ones cost two).
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = "^{}\\[~]|€";

/** SMS size: GSM-7 messages hold 160 characters (153 per part when split); anything else (e.g. emoji) is Unicode at 70 (67 per part). */
export function smsInfo(text: string): { encoding: "GSM-7" | "Unicode"; characters: number; segments: number } {
  let units = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else { gsm = false; break; }
  }
  if (!gsm) {
    const n = [...text].length;
    return { encoding: "Unicode", characters: n, segments: n === 0 ? 0 : n <= 70 ? 1 : Math.ceil(n / 67) };
  }
  return { encoding: "GSM-7", characters: units, segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153) };
}

/** A stable key from a name: lower-case words joined by underscores. */
export function templateKeyFrom(name: string): string {
  return (name ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}
