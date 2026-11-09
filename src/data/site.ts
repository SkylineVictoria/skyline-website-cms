export type NavChild = { label: string; to: string };
export type NavColumn = { title: string; links: NavChild[] };
export type NavItem = {
  label: string;
  to?: string;
  columns?: NavColumn[];
  children?: NavChild[];
  external?: boolean;
};

export const site = {
  name: "Skyline Institute Of Technology",
  shortName: "Skyline",
  logoAlt: "Skyline Institute Of Technology",
  phone: "03 9125 1661",
  phoneHref: "tel:0391251661",
  email: "info@slit.edu.au",
  emailHref: "mailto:info@slit.edu.au",
  admissionsEmail: "admissions@slit.edu.au",
  admissionsHref: "mailto:admissions@slit.edu.au",
  address: "Level 8/310 King St Melbourne VIC 3000, Australia",
  legal: "RTO 45989 CRICOS 04114B",
  footerIntro:
    "Skyline Institute of Technology are leaders in the provision of high-quality, higher-level technical education and training across a range of occupations and industries.",
  copyright: "Copyright © slit.edu.au 2026 . All rights reserved.",
  acknowledgement:
    "In the spirit of reconciliation SKYLINE INSTITUTE OF TECHNOLOGY acknowledges the Traditional Custodians of country throughout Australia and their connections to land, sea and community. We pay our respect to their Elders past, present and emerging and extend that respect to all Aboriginal and Torres Strait Islander peoples today.",
  signInUrl: "https://submissions.slit.edu.au/login",
  mapEmbedSrc:
    "https://maps.google.com/maps?q=Level%208%2F310%20King%20St%20Melbourne%20VIC%203000%2C%20Australia%20&t=m&z=14&output=embed&iwloc=near",
  social: [
    { label: "Facebook", href: "https://www.facebook.com/slit.edu.au/", icon: "ri-facebook-fill" },
    { label: "Instagram", href: "https://www.instagram.com/slit.edu.au/", icon: "ri-instagram-line" },
    { label: "LinkedIn", href: "https://www.linkedin.com/company/sliteducation", icon: "ri-linkedin-fill" },
    { label: "Twitter", href: "https://twitter.com/Sliteducation", icon: "ri-twitter-x-fill" },
    { label: "TikTok", href: "https://www.tiktok.com/@slit.edu.au", icon: "ri-tiktok-fill" },
  ],
};

export const navigation: NavItem[] = [
  { label: "Home", to: "/" },
  { label: "About Us", to: "/about-us" },
  {
    label: "Courses",
    to: "/our-courses",
    columns: [
      {
        title: "Automotive",
        links: [
          {
            label: "Certificate III in Light Vehicle Mechanical Technology",
            to: "/courses/certificate-iii-in-light-vehicle-mechanical-technology",
          },
          {
            label: "Certificate IV in Automotive Mechanical Diagnosis",
            to: "/courses/certificate-iv-in-automotive-mechanical-diagnosis",
          },
        ],
      },
      {
        title: "Building & Construction",
        links: [
          { label: "Certificate III in Carpentry", to: "/courses/cpc30220-certificate-iii-in-carpentry" },
          {
            label: "Certificate III in Painting and Decorating",
            to: "/courses/cpc30620-certificate-iii-in-painting-and-decorating",
          },
          {
            label: "Diploma of Building and Construction (Building)",
            to: "/courses/cpc50220-diploma-of-building-and-construction-building",
          },
        ],
      },
      {
        title: "Civil Construction Design",
        links: [
          {
            label: "Advanced Diploma of Civil Construction Design",
            to: "/courses/rii60520-advanced-diploma-of-civil-construction-design",
          },
          {
            label: "Advanced Diploma of Civil Construction Design (52 Weeks)",
            to: "/courses/rii60520-advanced-diploma-of-civil-construction-design-52weeks",
          },
          {
            label: "Diploma of Civil Construction Design",
            to: "/courses/rii50520-diploma-of-civil-construction-design",
          },
        ],
      },
      {
        title: "Furnishing & Glazing",
        links: [
          {
            label: "Certificate III in Cabinet Making and Timber Technology",
            to: "/courses/msf30322-certificate-iii-in-cabinet-making-and-timber-technology",
          },
          {
            label: "Certificate III in Glass and Glazing",
            to: "/courses/msf30422-certificate-iii-in-glass-and-glazing",
          },
        ],
      },
      {
        title: "Business & Management",
        links: [
          { label: "Diploma of Business", to: "/courses/diploma-of-business" },
          {
            label: "Advanced Diploma of Information Technology",
            to: "/courses/ict60220-advanced-diploma-of-information-technology",
          },
          {
            label: "Graduate Diploma of Management (Learning)",
            to: "/courses/bsb80120-graduate-diploma-of-management-learning",
          },
        ],
      },
    ],
  },
  {
    label: "Agents",
    children: [
      { label: "Become an Agent", to: "/become-an-agent" },
      { label: "Registered Agents", to: "/agents" },
    ],
  },
  {
    label: "Students",
    children: [
      { label: "Information", to: "/information" },
      { label: "Student Visa", to: "/student-visa" },
      { label: "OSHC", to: "/oshc" },
      { label: "Forms & Policies", to: "/forms-policies" },
    ],
  },
  { label: "Careers", to: "/careers" },
  { label: "Contact Us", to: "/contact" },
];

export const footerLinks: NavChild[] = [
  { label: "Home", to: "/" },
  { label: "About Us", to: "/about-us" },
  { label: "Courses", to: "/our-courses" },
  { label: "Registered Agents", to: "/agents" },
  { label: "Become an Agent", to: "/become-an-agent" },
  { label: "Careers", to: "/careers" },
  { label: "Contact Us", to: "/contact" },
];

export const studentLinks: NavChild[] = [
  { label: "Information", to: "/information" },
  { label: "Student Visa", to: "/student-visa" },
  { label: "OSHC", to: "/oshc" },
  { label: "Forms & Policies", to: "/forms-policies" },
];

export const newsItems = [
  {
    title: "International Education",
    href: "https://www.education.gov.au/international-education",
    image:
      "https://slit.edu.au/wp-content/uploads/2023/05/news3.jpg",
    alt: "International Education",
  },
  {
    title: "Assess your skills today",
    href: "https://www.tradesrecognitionaustralia.gov.au/",
    image: "https://slit.edu.au/wp-content/uploads/2023/05/news1.jpg",
    alt: "Assess your skills today",
  },
  {
    title: "During your studies in Australia",
    href: "https://www.education.gov.au/international-education/during-your-studies-australia-0",
    image: "https://slit.edu.au/wp-content/uploads/2023/05/news2.jpg",
    alt: "During your studies in Australia",
  },
];