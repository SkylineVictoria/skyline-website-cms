export type Role = "Admin" | "Editor";

export type PublishStatus = "Published" | "Draft";

export type ContentStatus = "Published" | "Draft" | "Archived";

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "Active" | "Inactive";
  lastLogin: string;
}

export interface CourseAttachment {
  id: string;
  name: string;
  url: string;
  originalFileName?: string;
  storageFileName?: string;
  bucketName?: string;
  storagePath?: string;
  mimeType?: string;
  fileSize?: number;
  /** Explicit opt-in required before a published PDF is assistant-indexed. */
  assistantPublicationApproved?: boolean;
}

export interface CourseLink {
  id: string;
  label: string;
  url: string;
  external: boolean;
}

export interface CourseSection {
  id: string;
  title: string;
  body: string;
}

export interface CourseUnit {
  id: string;
  code: string;
  name: string;
  category: string;
}

export interface AdminCourse {
  id: string;
  slug: string;
  code: string;
  cricos: string;
  name: string;
  category: string;
  trainingPackage: string;
  duration: string;
  mode: string;
  shortDescription: string;
  fullDescription: string;
  entryRequirements: string;
  career: string;
  fees: string;
  image: string;
  attachments: CourseAttachment[];
  links: CourseLink[];
  sections: CourseSection[];
  units: CourseUnit[];
  status: PublishStatus;
  displayOrder: number;
  featured: boolean;
  updatedAt: string;
  updatedBy: string;
}

export interface AdminPage {
  id: string;
  name: string;
  slug: string;
  title: string;
  body: string;
  inNav: boolean;
  seoTitle: string;
  seoDescription: string;
  status: PublishStatus;
  updatedAt: string;
  updatedBy: string;
}

export type FieldType =
  | "Text"
  | "Email"
  | "Phone"
  | "Number"
  | "Date"
  | "Dropdown"
  | "Radio"
  | "Checkbox"
  | "Textarea"
  | "File Upload"
  | "Section Heading"
  | "Static Note"
  | "Terms"
  | "Table";

export interface AdminFormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  help: string;
  options: string[];
  visible: boolean;
  /** Per field-type configuration, stored in cms_form_fields.config. */
  placeholder?: string;
  defaultValue?: string;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  fileTypes?: string;
  maxSizeMb?: number;
  /** Multiline rows for the Textarea type. */
  rows?: number;
}

export interface AdminForm {
  submitUrl?: string;
  submissionApproved?: boolean;
  id: string;
  name: string;
  description: string;
  fields: AdminFormField[];
  status: PublishStatus;
  updatedAt: string;
}

export interface MediaItem {
  id: string;
  name: string;
  url: string;
  type: string;
  sizeKb: number;
  uploadedAt: string;
  uploadedBy: string;
}

export interface DocItem {
  id: string;
  name: string;
  category: string;
  description: string;
  fileName: string;
  url: string;
  sizeLabel: string;
  docsCount: number;
  status: PublishStatus;
  displayOrder: number;
  originalFileName?: string;
  storageFileName?: string;
  bucketName?: string;
  storagePath?: string;
  mimeType?: string;
  fileSize?: number;
  /** Explicit opt-in required before a published PDF is assistant-indexed. */
  assistantPublicationApproved?: boolean;
}

export interface LinkItem {
  id: string;
  label: string;
  url: string;
  type: "Internal" | "External";
  target: "Same tab" | "New tab";
  group: string;
  order: number;
}

export interface ActivityItem {
  id: string;
  user: string;
  action: string;
  item: string;
  area: string;
  at: string;
}

export interface NavLinkItem {
  id: string;
  label: string;
  to: string;
  external: boolean;
  visible: boolean;
}

export interface NavMenuItem {
  id: string;
  label: string;
  to: string;
  visible: boolean;
  children: NavLinkItem[];
}

export interface FooterConfig {
  quickLinks?: { label: string; to: string }[];
  studentLinks?: { label: string; to: string }[];
  linksConfigured?: boolean;
  about: string;
  quickLinksTitle: string;
  studentLinksTitle: string;
  acknowledgement: string;
  copyright: string;
  showAcknowledgement: boolean;
}

export interface AdminSettings {
  primaryColor?: string;
  headingFont?: string;
  bodyFont?: string;
  themeConfigured?: boolean;
  /** Optional secondary colour (cms_settings.accent_color); empty keeps the neutral default accent. */
  accentColor?: string;
  /** Loader animation: ring, bar or dots (cms_settings.loader_style). */
  loaderStyle?: string;
  mapEmbedSrc?: string;
  name: string;
  shortName: string;
  logo: string;
  favicon: string;
  phone: string;
  email: string;
  admissionsEmail: string;
  address: string;
  rto: string;
  cricos: string;
  signInUrl: string;
  homeHeroImages: string[];
  homeAboutImage: string;
  social: { id: string; label: string; href: string; icon: string; enabled: boolean }[];
}

export interface SeoEntry {
  id: string;
  page: string;
  path: string;
  title: string;
  description: string;
  keywords: string;
}

export type RevisionEntity =
  | "course"
  | "page"
  | "form"
  | "document"
  | "link"
  | "seo"
  | "settings"
  | "contact"
  | "navigation"
  | "footer";

export interface Revision {
  id: string;
  entity: RevisionEntity;
  entityId: string;
  title: string;
  action: string;
  status: PublishStatus;
  by: string;
  at: string;
  snapshot: unknown;
}

export interface AdminData {
  settings: AdminSettings;
  courses: AdminCourse[];
  pages: AdminPage[];
  navigation: NavMenuItem[];
  footer: FooterConfig;
  forms: AdminForm[];
  media: MediaItem[];
  documents: DocItem[];
  links: LinkItem[];
  seo: SeoEntry[];
  users: AdminUser[];
  activity: ActivityItem[];
  revisions: Revision[];
}
