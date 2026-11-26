// Configuration contracts and verified application consumers. Credentials are stored only in Vault.
export type ManagedField = { key: string; label: string; secret?: boolean; required?: boolean; kind?: 'sandbox' };
type ManagedDefinition = {
  category: string;
  fields: ManagedField[];
  usage: string[];
  endpoint: string;
  runtime?: true;
  note?: string;
};

export const managedProviders = {
  openai: {
    category: 'Artificial Intelligence',
    fields: [
      { key: 'apiKey', label: 'API key', secret: true, required: true },
    ],
    usage: ['Learning with AI and MCQ practice', 'Application document extraction', 'Website assistant and indexing',
      'Staff onboarding document checks', 'LMS bulk upload', 'Assessment workbook import', 'Guest documents and validated document uploads'],
    endpoint: 'https://api.openai.com/v1',
    note: 'Model and base URL settings remain with the consuming workflows. The connection check uses the official OpenAI API.',
  },
  postmark: {
    category: 'Communication',
    fields: [
      { key: 'token', label: 'Server API token', secret: true, required: true },
    ],
    usage: ['Email sender', 'Support ticket mail', 'Notification delivery', 'HR onboarding and document signing mail', 'Portal activation mail'],
    endpoint: 'https://api.postmarkapp.com',
    note: 'The check verifies the server token. Sender identity and email delivery retain the settings of each mail workflow.',
  },
  geoscape: {
    category: 'Address Verification',
    fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }],
    usage: ['Application address autocomplete', 'Document signing onboarding', 'Staff onboarding'],
    endpoint: 'https://api.geoscape.com.au/v1/verify/autocomplete/AU',
  },
  training_gov_au: {
    category: 'Government & Compliance',
    fields: [
      { key: 'environment', label: 'Environment', kind: 'sandbox', required: true },
      { key: 'username', label: 'Username', required: true },
      { key: 'password', label: 'Password', secret: true, required: true },
    ],
    usage: ['Qualification search and import', 'Course and unit management', 'Assessment unit mapping (public training.gov.au data)'],
    endpoint: 'https://ws.sandbox.training.gov.au/Deewr.Tga.WebServices/TrainingComponentServiceV13.svc/Training',
    runtime: true,
    note: 'The credential applies to the sandbox SOAP service. Public unit content uses the existing public endpoint.',
  },
  cloudflare_turnstile: {
    category: 'Security',
    fields: [
      { key: 'siteKey', label: 'Site key', required: true },
      { key: 'secretKey', label: 'Secret key', secret: true, required: true },
    ],
    usage: ['Public staff registration'],
    endpoint: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    note: 'Validating the key pair with Cloudflare requires a fresh browser challenge token. This screen checks the field format. A changed site key requires a frontend rebuild and a coordinated server configuration change.',
  },
  abr: {
    category: 'Business Verification',
    fields: [{ key: 'guid', label: 'Authentication GUID', secret: true, required: true }],
    usage: ['Add business ABN prefill', 'Document signing business onboarding'],
    endpoint: 'https://abr.business.gov.au/json/AbnDetails.aspx',
    note: 'The existing public lookup workflow remains available where the application supports it.',
  },
  data_gov_au: {
    category: 'Government Reference Data',
    fields: [],
    usage: ['HRMS public holiday synchronisation', 'CRICOS provider and course lookup', 'Training.gov.au qualification CRICOS enrichment'],
    endpoint: 'https://data.gov.au/data/api/3/action',
    note: 'Australian Public Holidays Dates Machine Readable Dataset. Primary holiday source.',
  },
  nager_date: {
    category: 'Government Reference Data',
    fields: [],
    usage: ['HRMS public holiday synchronisation'],
    endpoint: 'https://date.nager.at/api/v3',
    note: 'Holiday fallback when the primary dataset is unavailable for a year.',
  },
} satisfies Record<string, ManagedDefinition>;

export type ManagedProvider = keyof typeof managedProviders;

export function managedDefinition(id: unknown): ManagedDefinition | undefined {
  return typeof id === 'string' && Object.hasOwn(managedProviders, id) ? managedProviders[id as ManagedProvider] : undefined;
}
