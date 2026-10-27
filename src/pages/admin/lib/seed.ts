import { courses as publicCourses } from "@/data/courses";
import { courseDetails } from "@/data/courseDetails";
import { courseUnits } from "@/data/courseUnits";
import { site, navigation as publicNav } from "@/data/site";
import { socialIconFor } from "@/lib/socialPlatforms";
import { contentPages, formsPoliciesPage, type Block } from "@/data/pages";
import { enrolSections, agentSections, type AppFieldType, type AppSection } from "@/data/applicationForms";
import { defaultUsers } from "./authContext";
import type {
  AdminCourse,
  AdminData,
  AdminForm,
  AdminFormField,
  AdminPage,
  ActivityItem,
  DocItem,
  FieldType,
  LinkItem,
  MediaItem,
  NavMenuItem,
  Revision,
  SeoEntry,
} from "./types";

const NOW = "2026-10-12 09:14";

export const courseCategories = [
  "Automotive",
  "Building & Construction",
  "Civil Construction Design",
  "Furnishing & Glazing",
  "Business & Management",
];

const trainingPackageByCategory: Record<string, string> = {
  Automotive: "AUR Automotive Retail, Service and Repair Training Package",
  "Building & Construction": "CPC Construction, Plumbing and Services Training Package",
  "Civil Construction Design": "RII Resources and Infrastructure Industry Training Package",
  "Furnishing & Glazing": "MSF Furnishing Training Package",
  "Business & Management": "BSB / ICT Business Services and Information Technology",
};

/* ------------------------------------------------------------------ Helpers */

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Converts a public content-page block list into rich HTML the CMS editor can load. */
function blocksToHtml(blocks: Block[]): string {
  const parts: string[] = [];
  blocks.forEach((block) => {
    switch (block.type) {
      case "paragraphs":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        block.paragraphs.forEach((p) => parts.push(`<p>${escapeHtml(p)}</p>`));
        break;
      case "list":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        parts.push(`<ul>${block.items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>`);
        break;
      case "links":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        parts.push(
          `<ul>${block.items
            .map((i) => `<li><a href="${i.href}">${escapeHtml(i.label)}</a></li>`)
            .join("")}</ul>`,
        );
        break;
      case "table":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        parts.push(
          `<table><thead><tr>${block.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>${block.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        );
        break;
      case "media":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        block.items.forEach((item) => {
          parts.push(`<p><img src="${item.image}" alt="${escapeHtml(item.alt)}" /></p>`);
          if (item.caption) parts.push(`<p>${escapeHtml(item.caption)}</p>`);
        });
        break;
      case "features":
        if (block.heading) parts.push(`<h3>${escapeHtml(block.heading)}</h3>`);
        parts.push(`<ul>${block.items.map((i) => `<li>${escapeHtml(i.title)}</li>`).join("")}</ul>`);
        break;
      default:
        break;
    }
  });
  return parts.join("\n");
}

const pageBody = (slug: string, fallback: string): string => {
  const page = contentPages[slug];
  return page ? blocksToHtml(page.blocks) : fallback;
};

const fieldTypeMap: Record<AppFieldType, FieldType> = {
  text: "Text",
  email: "Email",
  tel: "Phone",
  date: "Date",
  textarea: "Textarea",
  select: "Dropdown",
  radio: "Radio",
  checkbox: "Checkbox",
  file: "File Upload",
  terms: "Terms",
  static: "Static Note",
  table: "Table",
};

/** Converts the real on-page form sections into CMS form fields (with section headings). */
function formFieldsFromSections(sections: AppSection[]): AdminFormField[] {
  const out: AdminFormField[] = [];
  sections.forEach((section, si) => {
    if (section.title) {
      out.push({
        id: `f-${si}-heading`,
        label: section.title,
        type: "Section Heading",
        required: false,
        help: section.description ?? "",
        options: [],
        visible: true,
      });
    }
    section.fields.forEach((field, fi) => {
      const type = fieldTypeMap[field.type];
      const options =
        field.type === "table" ? (field.headers ?? []) : (field.options ?? []);
      out.push({
        id: `f-${si}-${fi}`,
        label: field.label || field.description || "Note",
        type,
        required: Boolean(field.required),
        help: field.type === "static" ? "" : (field.description ?? field.placeholder ?? ""),
        options,
        visible: true,
      });
    });
  });
  return out;
}

/* ---------------------------------------------------------------- Courses */

const seedCourses: AdminCourse[] = publicCourses.map((c, i) => {
  const detail = courseDetails[c.slug];
  const feeText = detail?.fee?.total
    ? [
        `Total Course Cost: ${detail.fee.total}`,
        detail.fee.tuition ? `Tuition: ${detail.fee.tuition}` : "",
        detail.fee.nonTuition ? `Non-Tuition: ${detail.fee.nonTuition}` : "",
        detail.fee.note ?? "",
      ]
        .filter(Boolean)
        .join("\n")
    : detail?.fee?.policyOnly
      ? "Please see the SLIT fee and charge policy for the current fees applicable to this qualification."
      : "Contact admissions for the current fee schedule.";

  const sections = [
    { id: `sec-${i + 1}-1`, title: "Course Overview", body: detail?.overview ?? c.summary ?? "" },
    {
      id: `sec-${i + 1}-2`,
      title: "Delivery",
      body: detail?.delivery.join("\n") ?? "",
    },
    { id: `sec-${i + 1}-3`, title: "Qualification", body: detail?.qualification ?? "" },
    {
      id: `sec-${i + 1}-4`,
      title: "Training Package Requirements",
      body: detail?.trainingPackage.join("\n") ?? "",
    },
    {
      id: `sec-${i + 1}-5`,
      title: "Duration",
      body: detail?.durationNotes.join("\n") ?? (c.duration ?? ""),
    },
    {
      id: `sec-${i + 1}-6`,
      title: "Location",
      body: [
        c.theoryLocation ? `Theory: ${c.theoryLocation}` : "",
        c.practicalLocation ? `Practical: ${c.practicalLocation}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    { id: `sec-${i + 1}-7`, title: "Credit Transfer", body: detail?.creditTransfer ?? "" },
    { id: `sec-${i + 1}-8`, title: "Recognition of Prior Learning (RPL)", body: detail?.rpl ?? "" },
  ].filter((s) => s.body.trim() !== "");

  const units = (courseUnits[c.slug] ?? []).map((unit, ui) => ({
    id: `unit-${i + 1}-${ui + 1}`,
    code: unit[0],
    name: unit[1],
    category: unit[2],
  }));

  return {
    id: `course-${i + 1}`,
    slug: c.slug,
    code: c.code ?? "",
    cricos: c.cricos ?? "",
    name: c.name,
    category: c.category,
    trainingPackage: trainingPackageByCategory[c.category] ?? "",
    duration: c.duration ?? "",
    mode: c.mode ?? "Face-to-Face",
    shortDescription: c.summary ?? "",
    fullDescription: detail?.overview ?? c.summary ?? "",
    entryRequirements: detail?.entryRequirements.join("\n") ?? c.entry ?? "Over 18 years of age",
    career: detail?.careers.join("\n") ?? "",
    fees: feeText,
    image: c.image ?? "",
    attachments: [
      { id: `att-${i + 1}-1`, name: `${c.code ?? c.name} Course Outline.pdf`, url: "#" },
      { id: `att-${i + 1}-2`, name: `${c.code ?? c.name} Fee Schedule.pdf`, url: "#" },
    ],
    links: [{ id: `lnk-${i + 1}-1`, label: "Enroll Now", url: "/enroll-now", external: false }],
    sections,
    units,
    status: "Published",
    displayOrder: i + 1,
    featured: i < 6,
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  };
});

/* ------------------------------------------------------------------ Pages */

const seedPages: AdminPage[] = [
  {
    id: "page-1",
    name: "Home",
    slug: "/",
    title: "Home",
    body:
      "<p>Homepage featuring the hero banner, the three service highlights (Education Services, International Hubs, World Class Academics), the About section, the featured course grid and the Latest News cards.</p>",
    inNav: true,
    seoTitle: "Skyline Institute Of Technology | Melbourne RTO & CRICOS Courses",
    seoDescription:
      "Skyline Institute Of Technology (RTO 45989, CRICOS 04114B) delivers hands-on technical education and training in Melbourne.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-2",
    name: "About Us",
    slug: "/about-us",
    title: "About Us",
    body: pageBody("about-us", ""),
    inNav: true,
    seoTitle: "About Us | Skyline Institute Of Technology",
    seoDescription:
      "Learn about Skyline Institute Of Technology, our approach to hands-on training and our purpose-built facilities.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-3",
    name: "Our Courses",
    slug: "/our-courses",
    title: "Our Courses",
    body:
      "<p>Full catalogue of accredited courses with category filters and search. Each course links through to its detail page.</p>",
    inNav: true,
    seoTitle: "Our Courses | Skyline Institute Of Technology",
    seoDescription:
      "Explore nationally recognised certificate and diploma courses at Skyline Institute Of Technology in Melbourne.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-4",
    name: "Course Detail (template)",
    slug: "/courses/:slug",
    title: "Course Detail",
    body:
      "<p>Reusable course detail template showing the course description, training package requirements, delivery, qualifications, entry requirements, units of competency, pathways, duration, fees, credit transfer, RPL and the apply CTA. Content is driven by each course.</p>",
    inNav: false,
    seoTitle: "Course | Skyline Institute Of Technology",
    seoDescription: "Study a nationally recognised course at Skyline Institute Of Technology in Melbourne.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-5",
    name: "Student Information",
    slug: "/information",
    title: "Information",
    body: pageBody("information", ""),
    inNav: true,
    seoTitle: "Student Information | Skyline Institute Of Technology",
    seoDescription:
      "Pre-departure, arrival and settling-in information for international students studying with Skyline Institute Of Technology.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-6",
    name: "Student Visa",
    slug: "/student-visa",
    title: "Student Visa",
    body: pageBody("student-visa", ""),
    inNav: true,
    seoTitle: "Student Visa | Skyline Institute Of Technology",
    seoDescription:
      "Guidance on Australian student visa requirements, conditions and how to apply as an international student.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-7",
    name: "OSHC",
    slug: "/oshc",
    title: "OSHC",
    body: pageBody("oshc", ""),
    inNav: true,
    seoTitle: "OSHC | Skyline Institute Of Technology",
    seoDescription:
      "Overseas Student Health Cover information and how to arrange it through Skyline Institute Of Technology.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-8",
    name: "Forms & Policies",
    slug: "/forms-policies",
    title: "Forms & Policies",
    body: pageBody("forms-policies", ""),
    inNav: true,
    seoTitle: "Forms & Policies | Skyline Institute Of Technology",
    seoDescription:
      "Download Skyline Institute Of Technology student forms, policies and procedures — enrolment, credit transfer, refunds, complaints and more.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-9",
    name: "Registered Agents",
    slug: "/agents",
    title: "Registered Agents",
    body: pageBody("agents", ""),
    inNav: true,
    seoTitle: "Registered Agents | Skyline Institute Of Technology",
    seoDescription:
      "Find a registered education agent of Skyline Institute Of Technology across Melbourne, Sydney, Brisbane, Perth, Adelaide and Canberra.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-10",
    name: "Become an Agent",
    slug: "/become-an-agent",
    title: "Become an Agent",
    body:
      "<p>Agent application page featuring the Agent Declaration and the full AGENT APPLICATION FORM (company, contact details, agency profile, references, attachments and consent). The form fields are managed in the Forms module.</p>",
    inNav: true,
    seoTitle: "Become an Agent | Skyline Institute Of Technology",
    seoDescription:
      "Apply to become an education agent for Skyline Institute Of Technology and complete the agent application form.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-11",
    name: "Contact Us",
    slug: "/contact",
    title: "Contact Us",
    body:
      "<p>Contact page with phone, email and campus address cards, the Inquiry form and the Google Map showing the Melbourne campus.</p>",
    inNav: true,
    seoTitle: "Contact Us | Skyline Institute Of Technology",
    seoDescription:
      "Contact Skyline Institute Of Technology in Melbourne — call 03 9125 1661, email info@slit.edu.au or visit Level 8, 310 King St, Melbourne VIC 3000.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-12",
    name: "Enroll Now",
    slug: "/enroll-now",
    title: "Enroll Now",
    body:
      "<p>International student application page featuring the application checklist and the full INTERNATIONAL STUDENT'S APPLICATION FORM. The form fields are managed in the Forms module.</p>",
    inNav: false,
    seoTitle: "Enroll Now | Skyline Institute Of Technology",
    seoDescription:
      "Apply online to study at Skyline Institute Of Technology and complete the international student application form.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
  {
    id: "page-13",
    name: "Not Found",
    slug: "/404",
    title: "Page Not Found",
    body: "<p>Friendly 404 page shown when a visitor reaches a URL that does not exist.</p>",
    inNav: false,
    seoTitle: "Page Not Found | Skyline Institute Of Technology",
    seoDescription: "The page you are looking for could not be found. Browse our courses or contact us.",
    status: "Published",
    updatedAt: NOW,
    updatedBy: "IT Administrator",
  },
];

/* ------------------------------------------------------------- Navigation */

const seedNavigation: NavMenuItem[] = publicNav.map((n, i) => ({
  id: `nav-${i + 1}`,
  label: n.label,
  to: n.to ?? "",
  visible: true,
  children: (n.children ?? []).map((c, j) => ({
    id: `nav-${i + 1}-${j + 1}`,
    label: c.label,
    to: c.to,
    external: false,
    visible: true,
  })),
}));

/* ------------------------------------------------------------------ Forms */

const contactFormFields: AdminFormField[] = [
  { id: "f-c-0", label: "Your Name", type: "Text", required: true, help: "Your Name", options: [], visible: true },
  { id: "f-c-1", label: "Your Email", type: "Email", required: true, help: "Your Email", options: [], visible: true },
  { id: "f-c-2", label: "Phone No", type: "Phone", required: true, help: "Phone No", options: [], visible: true },
  { id: "f-c-3", label: "Message", type: "Textarea", required: true, help: "Message", options: [], visible: true },
];

const seedForms: AdminForm[] = [
  {
    id: "form-enroll",
    name: "Enroll Now",
    description: "International student application form used on the Enroll Now page.",
    status: "Published",
    updatedAt: NOW,
    fields: formFieldsFromSections(enrolSections),
  },
  {
    id: "form-agent",
    name: "Become an Agent",
    description: "Education agent application form used on the Become an Agent page.",
    status: "Published",
    updatedAt: NOW,
    fields: formFieldsFromSections(agentSections),
  },
  {
    id: "form-contact",
    name: "Contact Us",
    description: "General enquiry form used on the Contact Us page.",
    status: "Published",
    updatedAt: NOW,
    fields: contactFormFields,
  },
];

/* ----------------------------------------------------------------- Media */

const seedMedia: MediaItem[] = publicCourses
  .filter((c) => c.image)
  .slice(0, 10)
  .map((c, i) => ({
    id: `media-${i + 1}`,
    name: `${c.imageAlt.replace(/\s+/g, "-").toLowerCase()}.jpg`,
    url: c.image as string,
    type: "image/jpeg",
    sizeKb: 180 + i * 24,
    uploadedAt: "2026-09-28 11:20",
    uploadedBy: "IT Administrator",
  }));

/* ------------------------------------------------------------- Documents */

const documentBlocks = formsPoliciesPage.blocks.filter(
  (block): block is Extract<Block, { type: "links" }> => block.type === "links",
);

const seedDocuments: DocItem[] = documentBlocks.flatMap((block) =>
  block.items.map((item, i) => ({
    id: `doc-${(block.heading ?? "docs").replace(/\s+/g, "-").toLowerCase()}-${i + 1}`,
    name: item.label,
    category: block.heading ?? "Documents",
    description: item.external ? "Opens in a new tab." : "",
    fileName: decodeURIComponent(item.href.split("/").pop() ?? "") || "document.pdf",
    url: item.href,
    sizeLabel: item.href.toLowerCase().endsWith(".pdf") ? "PDF" : "Link",
    docsCount: 1,
    status: "Published" as const,
    displayOrder: i + 1,
  })),
);

/* ----------------------------------------------------------------- Links */

const seedLinks: LinkItem[] = [
  { id: "link-1", label: "Enroll Now", url: "/enroll-now", type: "Internal", target: "Same tab", group: "Global CTA", order: 1 },
  { id: "link-2", label: "Student Portal Sign In", url: "https://submissions.slit.edu.au/login", type: "External", target: "New tab", group: "Global CTA", order: 2 },
  { id: "link-3", label: "International Education (Australian Government)", url: "https://www.education.gov.au/international-education", type: "External", target: "New tab", group: "Student Resources", order: 1 },
];

/* ------------------------------------------------------------------- SEO */

const seedSeo: SeoEntry[] = seedPages.map((p, i) => ({
  id: `seo-${i + 1}`,
  page: p.name,
  path: p.slug,
  title: p.seoTitle,
  description: p.seoDescription,
  keywords: "RTO Melbourne, international students, vocational training, Skyline Institute",
}));

/* -------------------------------------------------------------- Activity */

const seedActivity: ActivityItem[] = [
  { id: "act-1", user: "IT Administrator", action: "Updated", item: "Course MFS30422 Certificate III in Glass and Glazing", area: "Courses", at: "2026-10-12 09:14" },
  { id: "act-2", user: "IT Administrator", action: "Published", item: "Contact Us page", area: "Pages", at: "2026-10-11 15:02" },
  { id: "act-3", user: "Marketing Editor", action: "Replaced", item: "Refund Policy.pdf", area: "Documents", at: "2026-10-11 11:47" },
  { id: "act-4", user: "IT Administrator", action: "Modified", item: "Courses mega-menu", area: "Navigation", at: "2026-10-10 16:20" },
  { id: "act-5", user: "Marketing Editor", action: "Updated", item: "Home SEO description", area: "SEO", at: "2026-10-10 10:05" },
];

const seedRevisions: Revision[] = [
  ...seedCourses.slice(0, 6).map((c, i) => ({
    id: `rev-course-${i + 1}-b`,
    entity: "course" as const,
    entityId: c.id,
    title: c.name,
    action: "Published",
    status: "Published" as const,
    by: "IT Administrator",
    at: "2026-10-09 14:20",
    snapshot: c,
  })),
  ...seedCourses.slice(0, 6).map((c, i) => ({
    id: `rev-course-${i + 1}-a`,
    entity: "course" as const,
    entityId: c.id,
    title: c.name,
    action: "Saved draft",
    status: "Draft" as const,
    by: "IT Administrator",
    at: "2026-10-08 10:02",
    snapshot: { ...c, status: "Draft" },
  })),
  {
    id: "rev-page-1",
    entity: "page" as const,
    entityId: "page-1",
    title: "Home",
    action: "Published",
    status: "Published" as const,
    by: "IT Administrator",
    at: "2026-10-11 09:30",
    snapshot: seedPages[0],
  },
  {
    id: "rev-settings-1",
    entity: "settings" as const,
    entityId: "settings",
    title: "Website Settings",
    action: "Saved draft",
    status: "Draft" as const,
    by: "IT Administrator",
    at: "2026-10-10 12:15",
    snapshot: { name: site.name, shortName: site.shortName, rto: "45989", cricos: "04114B" },
  },
];

const seedFooter = {
  about: site.footerIntro,
  quickLinksTitle: "Quick Links",
  studentLinksTitle: "Student Links",
  acknowledgement: site.acknowledgement,
  copyright: site.copyright,
  showAcknowledgement: true,
};

export function buildSeed(): AdminData {
  return {
    settings: {
      name: site.name,
      shortName: site.shortName,
      logo: "https://slit.edu.au/wp-content/uploads/2023/06/logo-2.png",
      favicon: "https://slit.edu.au/wp-content/uploads/2023/06/cropped-site-270x270.png",
      phone: site.phone,
      email: site.email,
      admissionsEmail: site.admissionsEmail,
      address: site.address,
      rto: "45989",
      cricos: "04114B",
      signInUrl: site.signInUrl,
      homeHeroImages: [
        "https://static.readdy.ai/image/7fe129f8d7ac12cdc97a659d50dae110/10672c8cbcfc600c6073bd57b6040721.jpeg",
        "https://readdy.ai/api/search-image?query=Modern%20Australian%20training%20campus%20courtyard%20with%20diverse%20international%20students%20walking%20and%20talking%2C%20warm%20afternoon%20light%2C%20clean%20architectural%20lines%2C%20editorial%20photography%20with%20soft%20shadows&width=1920&height=1080&seq=skyline-hero-02&orientation=landscape",
        "https://readdy.ai/api/search-image?query=Bright%20modern%20technical%20workshop%20classroom%20with%20students%20learning%20hands-on%20skills%20and%20an%20instructor%20guiding%20them%2C%20warm%20neutral%20tones%2C%20clean%20professional%20editorial%20photography&width=1920&height=1080&seq=skyline-hero-03&orientation=landscape",
      ],
      homeAboutImage: "https://slit.edu.au/wp-content/uploads/2023/05/about_img_02.png",
      social: site.social.map((s, i) => ({
        id: `social-${i + 1}`,
        label: s.label,
        href: s.href,
        icon: socialIconFor(s.label),
        enabled: true,
      })),
    },
    courses: seedCourses,
    pages: seedPages,
    navigation: seedNavigation,
    footer: seedFooter,
    forms: seedForms,
    media: seedMedia,
    documents: seedDocuments,
    links: seedLinks,
    seo: seedSeo,
    users: defaultUsers,
    activity: seedActivity,
    revisions: seedRevisions,
  };
}
