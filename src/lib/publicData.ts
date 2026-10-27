import { supabase } from "@/pages/admin/lib/supabase";
import { resolveTenantSite, type TenantSite } from "@/lib/tenantSite";
import type { SiteTheme } from "@/lib/tenantTheme";
import { LOADER_STYLES, type LoaderStyle } from "@/config/cmsLimits";
import { safeContentUrl } from "@/lib/contentUrl";
import { indexCmsPages } from "@/lib/cmsPath";
import {
  site as staticSite,
  navigation as staticNavigation,
  footerLinks as staticFooterLinks,
  studentLinks as staticStudentLinks,
  type NavChild,
  type NavColumn,
  type NavItem,
} from "@/data/site";
import { courses as staticCourses, courseCategories as staticCategories, type Course } from "@/data/courses";
import type { RenderField } from "@/lib/formFields";

/**
 * Public (anonymous) runtime read layer.
 *
 * The CMS persists every change to the Supabase `cms_*` tables. The public
 * website reads those same tables here, at runtime, using the anonymous
 * Supabase client (RLS already restricts anonymous visitors to published
 * rows). The static modules under `src/data/*` are used ONLY as a graceful
 * fallback for first paint / total failure — never to override a successful
 * database response.
 */

const DEFAULT_LOGO = "https://slit.edu.au/wp-content/uploads/2023/06/logo-2.png";

const DEFAULT_HOME_ABOUT = "https://slit.edu.au/wp-content/uploads/2023/05/about_img_02.png";

const DEFAULT_HOME_HERO = [
  "https://static.readdy.ai/image/7fe129f8d7ac12cdc97a659d50dae110/10672c8cbcfc600c6073bd57b6040721.jpeg",
  "https://readdy.ai/api/search-image?query=Modern%20Australian%20training%20campus%20courtyard%20with%20diverse%20international%20students%20walking%20and%20talking%2C%20warm%20afternoon%20light%2C%20clean%20architectural%20lines%2C%20editorial%20photography%20with%20soft%20shadows&width=1920&height=1080&seq=skyline-hero-02&orientation=landscape",
  "https://readdy.ai/api/search-image?query=Bright%20modern%20technical%20workshop%20classroom%20with%20students%20learning%20hands-on%20skills%20and%20an%20instructor%20guiding%20them%2C%20warm%20neutral%20tones%2C%20clean%20professional%20editorial%20photography&width=1920&height=1080&seq=skyline-hero-03&orientation=landscape",
];

type Row = Record<string, any>;

const str = (v: unknown): string => (v == null ? "" : String(v));
const truthy = (v: unknown): boolean => v === true || v === "true";
const visible = (v: unknown): boolean => (v === undefined || v === null ? true : Boolean(v));
const firstLine = (v: unknown): string =>
  str(v)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)[0] ?? "";
const telHref = (value: string): string => `tel:${value.replace(/[^\d+]/g, "")}`;

export interface PublicSocialLink {
  label: string;
  href: string;
  icon: string;
}

export interface PublicSettings {
  /** The logo saved in Website Settings, or "" when none is set (logo itself falls back to the default image). */
  logoConfigured: string;
  name: string;
  shortName: string;
  logo: string;
  favicon: string;
  phone: string;
  phoneHref: string;
  email: string;
  emailHref: string;
  admissionsEmail: string;
  admissionsHref: string;
  address: string;
  rto: string;
  cricos: string;
  legal: string;
  signInUrl: string;
  homeHeroImages: string[];
  homeAboutImage: string;
  logoAlt: string;
  mapEmbedSrc: string;
  acknowledgement: string;
  footerIntro: string;
  copyright: string;
  social: PublicSocialLink[];
}

export interface PublicFooter {
  about: string;
  quickLinksTitle: string;
  studentLinksTitle: string;
  acknowledgement: string;
  copyright: string;
  showAcknowledgement: boolean;
}

export interface PublicPageContent {
  title: string;
  body: string;
  seoTitle?: string;
  seoDescription?: string;
}

export interface PublicDocumentGroup {
  title: string;
  items: { label: string; href: string; external: boolean }[];
}

export interface PublicForm {
  submitUrl?: string;
  submissionApproved?: boolean;
  id: string;
  name: string;
  description: string;
  fields: RenderField[];
}

export interface PublicSiteData {
  publicVersion?: number;
  courseContent?: Record<string, { description: string; sections: { title: string; body: string }[] }>;
  theme?: SiteTheme;
  tenantSite?: TenantSite;
  seo?: { path: string; title: string; description: string; keywords: string }[];
  settings: PublicSettings;
  navigation: NavItem[];
  footer: PublicFooter;
  footerLinks: NavChild[];
  studentLinks: NavChild[];
  courses: Course[];
  featuredCourses: Course[];
  courseCategories: string[];
  pages: Record<string, PublicPageContent>;
  documentGroups: PublicDocumentGroup[];
  forms: PublicForm[];
  /**
   * True only when the CMS has real records in Supabase and this data was built
   * from them. When true, the database is authoritative and components must NOT
   * fall back to static content (an intentionally empty list stays empty).
   */
  backedByDatabase: boolean;
}

/* ------------------------------------------------------------------ Helpers */

function socialIcon(label: string): string {
  const match = staticSite.social.find(
    (item) => item.label.toLowerCase() === label.trim().toLowerCase(),
  );
  return match?.icon ?? "ri-share-line";
}

function orderCategories(categories: string[]): string[] {
  const present = new Set(categories.filter(Boolean));
  const ordered = staticCategories.filter((category) => present.has(category));
  const extras = [...present].filter((category) => !staticCategories.includes(category)).sort();
  return [...ordered, ...extras];
}

/* -------------------------------------------------------------- Mappings */

const loaderStyleOf = (value: unknown): LoaderStyle => ((LOADER_STYLES as readonly unknown[]).includes(value) ? (value as LoaderStyle) : "ring");

function buildSettings(rows: Row[], socialRows: Row[], tenant = false): PublicSettings {
  const row = rows[0] ?? {};
  const social = socialRows
    .slice()
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    .filter((item) => (item.visible === undefined ? true : Boolean(item.visible)))
    .map((item): PublicSocialLink => ({
      label: str(item.label),
      href: safeContentUrl(str(item.href)),
      icon: str(item.icon) || socialIcon(str(item.label)),
    }))
    .filter((item) => item.label && item.href);

  const phone = str(row.phone) || staticSite.phone;
  const email = str(row.email) || staticSite.email;
  const admissionsEmail = str(row.admissions_email) || staticSite.admissionsEmail;
  const rto = str(row.rto);
  const cricos = str(row.cricos);
  const heroImages = Array.isArray(row.home_hero_images)
    ? (row.home_hero_images as unknown[]).map((v) => str(v)).filter(Boolean)
    : [];

  if (tenant) {
    return {
      logoConfigured: str(row.logo), name: str(row.name), shortName: str(row.short_name), logo: str(row.logo), favicon: str(row.favicon),
      phone: str(row.phone), phoneHref: telHref(str(row.phone)), email: str(row.email), emailHref: `mailto:${str(row.email)}`,
      admissionsEmail: str(row.admissions_email), admissionsHref: `mailto:${str(row.admissions_email)}`,
      address: str(row.address), rto, cricos, legal: [rto && `RTO ${rto}`, cricos && `CRICOS ${cricos}`].filter(Boolean).join(" "),
      signInUrl: str(row.sign_in_url), homeHeroImages: heroImages, homeAboutImage: str(row.home_about_image),
      logoAlt: str(row.name), mapEmbedSrc: str(row.map_embed_src), acknowledgement: "", footerIntro: "", copyright: "", social,
    };
  }

  return {
    logoConfigured: str(row.logo),
    name: str(row.name) || staticSite.name,
    shortName: str(row.short_name) || staticSite.shortName,
    logo: str(row.logo) || DEFAULT_LOGO,
    favicon: str(row.favicon) || staticSite.logoAlt,
    phone,
    phoneHref: telHref(phone),
    email,
    emailHref: `mailto:${email}`,
    admissionsEmail,
    admissionsHref: `mailto:${admissionsEmail}`,
    address: str(row.address) || staticSite.address,
    rto,
    cricos,
    legal: rto || cricos ? `RTO ${rto} CRICOS ${cricos}`.replace(/\s+/g, " ").trim() : staticSite.legal,
    signInUrl: str(row.sign_in_url) || staticSite.signInUrl,
    homeHeroImages: heroImages.length ? heroImages : DEFAULT_HOME_HERO,
    homeAboutImage: str(row.home_about_image) || DEFAULT_HOME_ABOUT,
    logoAlt: str(row.name) || staticSite.logoAlt,
    mapEmbedSrc: staticSite.mapEmbedSrc,
    acknowledgement: staticSite.acknowledgement,
    footerIntro: staticSite.footerIntro,
    copyright: staticSite.copyright,
    social: social.length ? social : staticSite.social.map((s) => ({ label: s.label, href: s.href, icon: s.icon })),
  };
}

function buildFooter(rows: Row[], tenant = false): PublicFooter {
  const row = rows[0] ?? {};
  if (tenant) return {
    about: str(row.about), quickLinksTitle: str(row.quick_links_title), studentLinksTitle: str(row.student_links_title),
    acknowledgement: str(row.acknowledgement), copyright: str(row.copyright), showAcknowledgement: row.show_acknowledgement === true,
  };
  return {
    about: str(row.about) || staticSite.footerIntro,
    quickLinksTitle: str(row.quick_links_title) || "Quick Links",
    studentLinksTitle: str(row.student_links_title) || "Student Links",
    acknowledgement: str(row.acknowledgement) || staticSite.acknowledgement,
    copyright: str(row.copyright) || staticSite.copyright,
    showAcknowledgement: visible(row.show_acknowledgement),
  };
}

function toCourse(row: Row, sections: Row[], units: Row[], attachments: Row[]): Course {
  const mine = sections
    .filter((section) => section.course_id === row.id)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));
  const location = mine.find((section) => str(section.title).toLowerCase().includes("location"));
  const locationBody = location ? str(location.body) : "";
  const theory = /theory\s*:\s*(.+)/i.exec(locationBody)?.[1]?.trim();
  const practical = /practical\s*:\s*(.+)/i.exec(locationBody)?.[1]?.trim();

  const myUnits = units
    .filter((unit) => unit.course_id === row.id)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    .map((unit) => ({
      code: str(unit.code),
      name: str(unit.name),
      category: str(unit.category) || "Core",
    }))
    .filter((unit) => unit.code || unit.name);
  // `url` is the migrated Storage URL when available, otherwise the retained
  // legacy URL. This keeps the public site and CMS on the same record during a
  // staged attachment migration.
  const myAttachments = attachments
    .filter((attachment) => attachment.course_id === row.id)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
    .map((attachment) => ({
      id: str(attachment.id),
      name: str(attachment.name) || str(attachment.original_file_name) || "Course document",
      url: safeContentUrl(str(attachment.url)),
    }))
    .filter((attachment) => attachment.url && attachment.url !== "#");

  return {
    slug: str(row.slug),
    code: str(row.code) || undefined,
    cricos: str(row.cricos) || undefined,
    name: str(row.name),
    category: str(row.category),
    image: safeContentUrl(str(row.image), "image"),
    imageAlt: str(row.name),
    summary: str(row.short_description) || undefined,
    mode: str(row.mode) || undefined,
    duration: str(row.duration) || undefined,
    entry: firstLine(row.entry_requirements) || undefined,
    theoryLocation: theory,
    practicalLocation: practical,
    units: myUnits,
    attachments: myAttachments,
  };
}

function buildCourseResults(
  rows: Row[],
  sections: Row[],
  units: Row[],
  attachments: Row[],
): { courses: Course[]; featured: Course[] } {
  const published = rows
    .filter((row) => str(row.status) === "Published")
    .sort(
      (a, b) =>
        Number(a.display_order ?? 0) - Number(b.display_order ?? 0) ||
        str(a.name).localeCompare(str(b.name)),
    );
  const courses = published.map((row) => toCourse(row, sections, units, attachments)).filter((course) => course.slug && course.name);
  const featured = published
    .filter((row) => truthy(row.featured))
    .map((row) => toCourse(row, sections, units, attachments))
    .filter((course) => course.slug && course.name);
  return { courses, featured };
}

function buildCourseColumns(courses: Course[]): NavColumn[] {
  const groups = new Map<string, Course[]>();
  courses.forEach((course) => {
    const key = course.category || "Courses";
    const list = groups.get(key) ?? [];
    list.push(course);
    groups.set(key, list);
  });
  const order = orderCategories([...groups.keys()]);
  const keys = [...groups.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return keys.map((key) => ({
    title: key,
    links: (groups.get(key) ?? []).map((course) => ({ label: course.name, to: `/courses/${course.slug}` })),
  }));
}

function buildNavigation(rows: Row[], courseColumns: NavColumn[]): NavItem[] {
  const shown = rows.filter((row) => visible(row.visible));
  const parents = shown
    .filter((row) => !row.parent_id)
    .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0));

  return parents
    .map((parent): NavItem => {
      const children = shown
        .filter((row) => row.parent_id === parent.id)
        .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
        .map((row): NavChild => ({ label: str(row.label), to: safeContentUrl(str(row.to_path)) }))
        .filter((child) => child.label);

      const item: NavItem = {
        label: str(parent.label),
        to: safeContentUrl(str(parent.to_path)) || undefined,
        external: truthy(parent.external),
      };
      if (children.length) item.children = children;
      if (item.to === "/our-courses" && courseColumns.length) item.columns = courseColumns;
      return item;
    })
    .filter((item) => item.label);
}

function buildPages(rows: Row[]): Record<string, PublicPageContent> {
  return indexCmsPages(rows
    .filter((row) => str(row.status) === "Published")
    .map((row) => ({ slug: str(row.slug), page: {
      title: str(row.title) || str(row.name), body: str(row.body),
      seoTitle: str(row.seo_title), seoDescription: str(row.seo_description),
    } })));
}

/* ------------------------------------------------------------------ Forms */

function formFieldConfig(config: unknown): Partial<RenderField> {
  const c = config && typeof config === "object" ? (config as Row) : {};
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  return {
    placeholder: str(c.placeholder) || undefined,
    defaultValue: str(c.defaultValue) || undefined,
    maxLength: num(c.maxLength),
    min: str(c.min) || undefined,
    max: str(c.max) || undefined,
    step: str(c.step) || undefined,
    fileTypes: str(c.fileTypes) || undefined,
    maxSizeMb: num(c.maxSizeMb),
    rows: num(c.rows),
  };
}

function buildForms(formRows: Row[], fieldRows: Row[]): PublicForm[] {
  return formRows
    .filter((f) => str(f.status) === "Published")
    .map((f): PublicForm => ({
      submitUrl: f.submission_approved ? safeContentUrl(str(f.submit_url)) : undefined,
      submissionApproved: f.submission_approved === true,
      id: str(f.id),
      name: str(f.name),
      description: str(f.description),
      fields: fieldRows
        .filter((field) => field.form_id === f.id)
        .sort((a, b) => Number(a.sort ?? 0) - Number(b.sort ?? 0))
        .map((field): RenderField => {
          const cfg = formFieldConfig(field.config);
          return {
            id: str(field.id),
            label: str(field.label),
            type: (str(field.type) || "Text") as RenderField["type"],
            required: truthy(field.required),
            help: str(field.help),
            options: Array.isArray(field.options) ? (field.options as string[]) : [],
            visible: visible(field.visible),
            ...cfg,
          };
        }),
    }));
}

function buildDocumentGroups(rows: Row[]): PublicDocumentGroup[] {
  const groups = new Map<string, PublicDocumentGroup>();
  rows
    .filter((row) => str(row.status) === "Published")
    .sort(
      (a, b) =>
        Number(a.display_order ?? 0) - Number(b.display_order ?? 0) ||
        str(a.name).localeCompare(str(b.name)),
    )
    .forEach((row) => {
      const title = str(row.category) || "Documents";
      const group = groups.get(title) ?? { title, items: [] };
    const url = safeContentUrl(str(row.url));
      group.items.push({ label: str(row.name), href: url, external: /^https?:/i.test(url) });
      groups.set(title, group);
    });

  // The public Forms & Policies page always shows Forms first, then Policies,
  // then any other sections alphabetically — independent of the display_order
  // values across sections.
  const preferred = ["Forms", "Policies"];
  return [...groups.keys()]
    .sort((a, b) => {
      const ia = preferred.indexOf(a);
      const ib = preferred.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    })
    .map((key) => groups.get(key) as PublicDocumentGroup);
}

/* ----------------------------------------------------------------- Loading */

export async function loadPublicSiteData(): Promise<PublicSiteData> {
  const tenantSite = await resolveTenantSite();
  const publicVersion = tenantSite?.contentVersion ?? Number((await supabase.rpc("cms_public_revision")).data?.contentVersion ?? 0);
  const { data: snapshot, error } = await supabase.rpc("cms_public_snapshot");
  if (error) throw new Error("Could not load website content.");
  const fetchRows = async (table: string, orderBy?: string): Promise<Row[]> => {
    const rows = [...(snapshot?.[table] ?? [])] as Row[];
    return orderBy ? rows.sort((a, b) => Number(a[orderBy] ?? 0) - Number(b[orderBy] ?? 0)) : rows;
  };
  const [
    settingsRows,
    socialRows,
    navRows,
    footerRows,
    courseRows,
    sectionRows,
    unitRows,
    attachmentRows,
    pageRows,
    documentRows,
    formRows,
    formFieldRows,
  ] = await Promise.all([
    fetchRows("cms_settings"),
    fetchRows("cms_social_links", "sort"),
    fetchRows("cms_navigation_items", "sort"),
    fetchRows("cms_footer"),
    fetchRows("cms_courses", "display_order"),
    fetchRows("cms_course_sections", "sort"),
    fetchRows("cms_course_units", "sort"),
    fetchRows("cms_course_attachments", "sort"),
    fetchRows("cms_pages"),
    fetchRows("cms_documents", "display_order"),
    fetchRows("cms_forms"),
    fetchRows("cms_form_fields", "sort"),
  ]);

  // A never-seeded project has no CMS records at all. In that one case we keep
  // the shipped static content so a brand-new site is not blank. As soon as any
  // CMS record exists, the database becomes the single source of truth and its
  // state (including intentionally empty lists) is used verbatim.
  const seeded =
    settingsRows.length > 0 ||
    navRows.length > 0 ||
    courseRows.length > 0 ||
    pageRows.length > 0 ||
    documentRows.length > 0 ||
    formRows.length > 0;

  if (!seeded && !tenantSite) {
    return fallbackSiteData();
  }

  const { courses, featured } = buildCourseResults(courseRows, sectionRows, unitRows, attachmentRows);
  const courseColumns = buildCourseColumns(courses);
  const settings = buildSettings(settingsRows, socialRows, !!tenantSite);
  settings.logo = safeContentUrl(settings.logo, "image");
  settings.favicon = safeContentUrl(settings.favicon, "image");
  settings.signInUrl = safeContentUrl(settings.signInUrl);
  settings.homeAboutImage = safeContentUrl(settings.homeAboutImage, "image");
  settings.homeHeroImages = settings.homeHeroImages.map((url) => safeContentUrl(url, "image")).filter(Boolean);
  const footerLinks = (rows: NavChild[]): NavChild[] => rows.map((link) => ({ label: str(link.label), to: safeContentUrl(str(link.to)) })).filter((link) => link.to);

  return {
    tenantSite: tenantSite ?? undefined,
    publicVersion,
    courseContent: Object.fromEntries(courseRows.map((row) => [str(row.slug), { description: str(row.full_description), sections: sectionRows.filter((section) => section.course_id === row.id).map((section) => ({ title: str(section.title), body: str(section.body) })) }])),
    theme: tenantSite || settingsRows[0]?.theme_configured ? { primaryColor: str(settingsRows[0]?.primary_color), accentColor: str(settingsRows[0]?.accent_color) || undefined, loaderStyle: loaderStyleOf(settingsRows[0]?.loader_style), headingFont: str(settingsRows[0]?.heading_font), bodyFont: str(settingsRows[0]?.body_font) } : undefined,
    seo: (snapshot?.cms_seo ?? []).map((s: Row) => ({ path: str(s.path), title: str(s.title), description: str(s.description), keywords: str(s.keywords) })),
    settings,
    navigation: buildNavigation(navRows, courseColumns),
    footer: buildFooter(footerRows, !!tenantSite),
    footerLinks: footerLinks(tenantSite || footerRows[0]?.links_configured ? (footerRows[0]?.quick_links ?? []) : staticFooterLinks),
    studentLinks: footerLinks(tenantSite || footerRows[0]?.links_configured ? (footerRows[0]?.student_links ?? []) : staticStudentLinks),
    courses,
    featuredCourses: featured.length ? featured : courses.slice(0, 6),
    courseCategories: orderCategories(courses.map((course) => course.category)),
    pages: buildPages(pageRows),
    documentGroups: buildDocumentGroups(documentRows),
    forms: buildForms(formRows, formFieldRows),
    backedByDatabase: true,
  };
}

/**
 * Static fallback used for first paint and when the database is unreachable.
 * Collections are intentionally empty-friendly: the pages that render them
 * fall back to their own static source only while this fallback is in effect.
 */
export function fallbackSiteData(): PublicSiteData {
  return {
    settings: buildSettings([], []),
    navigation: staticNavigation,
    footer: buildFooter([]),
    footerLinks: staticFooterLinks,
    studentLinks: staticStudentLinks,
    courses: staticCourses,
    featuredCourses: staticCourses.slice(0, 6),
    courseCategories: staticCategories,
    pages: {},
    documentGroups: [],
    forms: [],
    backedByDatabase: false,
  };
}
