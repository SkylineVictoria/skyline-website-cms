import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { NavItem } from "@/data/site";
import { usePublicSite } from "@/hooks/publicSiteContext";
import { useSignedIn } from "@/hooks/useSignedIn";
import { headerAccountLink } from "@/lib/loginRouting";

function Logo({ src, alt }: { src: string; alt: string }) {
  return <img src={src} alt={alt} className="h-11 w-auto object-contain md:h-12" />;
}

function DesktopDropdown({ item }: { item: NavItem }) {
  return (
    <div className="absolute left-0 top-full z-50 hidden pt-3 group-hover:block group-focus-within:block">
      <div className="min-w-[240px] rounded-card border border-background-200 bg-background-50 p-3 shadow-xl">
        <ul className="space-y-1">
          {(item.children ?? []).map((child, index) => (
            <li key={`${child.to}-${index}`}>
              <Link
                to={child.to}
                className="block rounded-md px-3 py-2 text-sm text-foreground-700 transition-colors hover:bg-background-100 hover:text-primary-600"
              >
                {child.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export interface HeaderViewSettings {
  logo: string; logoAlt: string; phone: string; phoneHref: string; email: string; emailHref: string;
  social: { label: string; href: string; icon: string }[];
}

/**
 * The one header renderer: the public site feeds it the published navigation, the CMS preview feeds it unsaved edits.
 * In preview mode it is not sticky and the surrounding editor blocks navigation.
 */
export function SiteHeaderView({ navigation, settings, preview = false }: { navigation: NavItem[]; settings: HeaderViewSettings; preview?: boolean }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [openAccordion, setOpenAccordion] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [coursesOpen, setCoursesOpen] = useState(false);
  const [query, setQuery] = useState("");
  const location = useLocation();
  const navigate = useNavigate();
  // Preview mode never reads the session; the public header swaps Sign In for Dashboard once signed in (both go through /login).
  const signedIn = useSignedIn();
  const account = headerAccountLink(signedIn && !preview);

  const courseMenu = navigation.find((item) => item.columns);
  const courseColumns = courseMenu?.columns ?? [];

  useEffect(() => {
    setMobileOpen(false);
    setOpenAccordion(null);
    setSearchOpen(false);
    setCoursesOpen(false);
  }, [location.pathname]);

  // How many top-level items fit on one line; the rest go under "More". Re-measured when the menu or the width changes.
  const navRef = useRef<HTMLElement | null>(null);
  const [fit, setFit] = useState(navigation.length);
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) { setFit(navigation.length); return undefined; }
    const MORE_WIDTH = 92;
    const measure = () => {
      const widths = Array.from(nav.querySelectorAll<HTMLElement>("[data-nav-measure] > span")).map((el) => el.offsetWidth);
      const available = nav.clientWidth;
      if (!available || !widths.length) { setFit(navigation.length); return; }
      const total = widths.reduce((sum, w) => sum + w + 4, 0);
      if (total <= available) { setFit(widths.length); return; }
      let used = MORE_WIDTH, count = 0;
      for (const w of widths) { if (used + w + 4 > available) break; used += w + 4; count += 1; }
      setFit(Math.max(1, count));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(nav);
    void document.fonts?.ready.then(measure);
    return () => observer?.disconnect();
  }, [navigation]);

  const renderDesktopItem = (item: NavItem, index: number) => (
    <div
                key={`${item.label}-${index}`}
                className="group relative"
                onMouseEnter={() => setCoursesOpen(Boolean(item.columns))}
              >
                {item.to && !item.children && !item.columns ? (
                  <Link
                    to={item.to}
                    className="flex items-center whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-foreground-800 transition-colors hover:text-primary-600"
                  >
                    {item.label}
                  </Link>
                ) : item.to ? (
                  <Link
                    to={item.to}
                    aria-haspopup="true"
                    aria-expanded={item.columns ? coursesOpen : undefined}
                    onFocus={() => setCoursesOpen(Boolean(item.columns))}
                    className="flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-foreground-800 transition-colors hover:text-primary-600"
                  >
                    {item.label}
                    <i className="ri-arrow-down-s-line text-base" aria-hidden="true" />
                  </Link>
                ) : (
                  <button
                    type="button"
                    aria-haspopup="true"
                    className="flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-foreground-800 transition-colors hover:text-primary-600"
                  >
                    {item.label}
                    <i className="ri-arrow-down-s-line text-base" aria-hidden="true" />
                  </button>
                )}
                {item.children ? <DesktopDropdown item={item} /> : null}
              </div>
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    setSearchOpen(false);
    setQuery("");
    navigate(value ? `/our-courses?q=${encodeURIComponent(value)}` : "/our-courses");
  };

  return (
    <header className={`${preview ? "relative" : "sticky top-0 z-50"} w-full`}>
      <div className="hidden border-b border-background-200 bg-background-100 md:block">
        <div className="site-container flex items-center justify-between py-2.5">
          <div className="flex items-center gap-3">
            {settings.social.map((social) => (
              <a
                key={social.label}
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={social.label}
                className="flex h-8 w-8 items-center justify-center rounded-full text-foreground-600 transition-colors hover:bg-background-200 hover:text-primary-600"
              >
                <i className={`${social.icon} text-base`} aria-hidden="true" />
              </a>
            ))}
          </div>
          <div className="flex items-center gap-6">
            <a href={settings.phoneHref} className="flex items-center gap-2 text-sm text-foreground-700 hover:text-primary-600">
              <i className="ri-phone-line text-base text-primary-600" aria-hidden="true" />
              <span className="font-label text-xs uppercase tracking-wide text-foreground-500">Call Now !</span>
              <strong className="font-semibold">{settings.phone}</strong>
            </a>
            <a href={settings.emailHref} className="flex items-center gap-2 text-sm text-foreground-700 hover:text-primary-600">
              <i className="ri-mail-line text-base text-primary-600" aria-hidden="true" />
              <span className="font-label text-xs uppercase tracking-wide text-foreground-500">Email Now</span>
              <strong className="font-semibold">{settings.email}</strong>
            </a>
          </div>
        </div>
      </div>

      <div
        className="relative border-b border-background-200 bg-background-50/95 backdrop-blur"
        onMouseLeave={() => setCoursesOpen(false)}
      >
        <div className="site-container flex items-center justify-between py-3.5">
          <Link to="/" aria-label={settings.logoAlt} className="flex items-center">
            <Logo src={settings.logo} alt={settings.logoAlt} />
          </Link>

          <nav ref={navRef} className="relative hidden min-w-0 flex-1 items-center justify-center gap-1 lg:flex" aria-label="Main navigation">
            {/* Invisible copy used only to measure label widths, so extra items can move into "More" before they would wrap or overlap. */}
            <div aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 whitespace-nowrap" data-nav-measure>
              {navigation.map((item, index) => (
                <span key={`${item.label}-${index}`} className="px-3 py-2 text-sm font-medium">{item.label}{item.children || item.columns ? <i className="ri-arrow-down-s-line text-base" /> : null}</span>
              ))}
            </div>
            {navigation.slice(0, fit).map((item, index) => renderDesktopItem(item, index))}
            {fit < navigation.length ? (
              <div className="group relative" onMouseEnter={() => setCoursesOpen(false)}>
                <button type="button" aria-haspopup="true" className="flex items-center gap-1 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium text-foreground-800 transition-colors hover:text-primary-600">
                  More
                  <i className="ri-arrow-down-s-line text-base" aria-hidden="true" />
                </button>
                <div className="absolute right-0 top-full z-50 hidden pt-3 group-hover:block group-focus-within:block">
                  <div className="max-h-[70vh] min-w-[240px] max-w-[320px] overflow-y-auto rounded-card border border-background-200 bg-background-50 p-3 shadow-xl">
                    <ul className="space-y-1">
                      {navigation.slice(fit).map((item, index) => (
                        <li key={`${item.label}-${index}`}>
                          {item.to ? <Link to={item.to} className="block rounded-md px-3 py-2 text-sm font-medium text-foreground-800 transition-colors hover:bg-background-100 hover:text-primary-600">{item.label}</Link> : <p className="px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-foreground-500">{item.label}</p>}
                          {item.children?.map((child, childIndex) => (
                            <Link key={`${child.to}-${childIndex}`} to={child.to} className="block rounded-md py-1.5 pl-6 pr-3 text-sm text-foreground-700 transition-colors hover:bg-background-100 hover:text-primary-600">{child.label}</Link>
                          ))}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            ) : null}
          </nav>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen((open) => !open)}
              aria-label="Search courses"
              aria-expanded={searchOpen}
              className="hidden h-10 w-10 items-center justify-center rounded-full text-foreground-700 transition-colors hover:bg-background-100 hover:text-primary-600 md:flex"
            >
              <i className="ri-search-line text-lg" aria-hidden="true" />
            </button>
            <Link
              to={account.to}
              className="hidden whitespace-nowrap text-sm font-medium text-foreground-700 transition-colors hover:text-primary-600 md:block"
            >
              {account.label}
            </Link>
            <Link
              to="/enroll-now"
              className="hidden whitespace-nowrap rounded-md bg-primary-500 px-5 py-2.5 text-sm font-semibold text-background-50 transition-colors hover:bg-primary-600 md:inline-block"
            >
              Enroll Now
            </Link>
            <button
              type="button"
              onClick={() => setMobileOpen((open) => !open)}
              aria-label="Toggle navigation menu"
              aria-expanded={mobileOpen}
              className="flex h-10 w-10 items-center justify-center rounded-md border border-background-200 text-foreground-800 lg:hidden"
            >
              <i className={mobileOpen ? "ri-close-line text-xl" : "ri-menu-3-line text-xl"} aria-hidden="true" />
            </button>
          </div>
        </div>

        {coursesOpen ? (
          <div className="absolute left-1/2 top-full z-50 hidden w-[min(92vw,1080px)] -translate-x-1/2 pt-3 lg:block">
            <div className="max-h-[calc(100vh-9rem)] overflow-y-auto rounded-card border border-background-200 bg-background-50 p-6 shadow-xl">
              <div className="flex items-center justify-between gap-4 border-b border-background-200 pb-4">
                <p className="font-heading text-sm font-semibold text-foreground-950">Browse our courses</p>
                <span className="font-label text-xs uppercase tracking-wide text-foreground-500">
                  {courseColumns.reduce((total, column) => total + column.links.length, 0)} qualifications
                </span>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-6 lg:grid-cols-3">
                {courseColumns.map((column) => (
                  <div key={column.title}>
                    <p className="font-label text-xs font-semibold uppercase tracking-wider text-primary-600">
                      {column.title}
                    </p>
                    <ul className="mt-3 space-y-2">
                      {column.links.map((link) => (
                        <li key={link.to}>
                          <Link
                            to={link.to}
                            className="block text-sm leading-snug text-foreground-700 transition-colors hover:text-primary-600"
                          >
                            {link.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
              <div className="mt-6 border-t border-background-200 pt-4">
                <Link
                  to="/our-courses"
                  className="inline-flex items-center gap-2 text-sm font-semibold text-primary-600 hover:text-primary-700"
                >
                  View all courses
                  <i className="ri-arrow-right-line" aria-hidden="true" />
                </Link>
              </div>
            </div>
          </div>
        ) : null}

        {searchOpen ? (
          <div className="border-t border-background-200 bg-background-50">
            <form onSubmit={submitSearch} className="site-container flex items-center gap-3 py-3">
              <i className="ri-search-line text-lg text-foreground-500" aria-hidden="true" />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search courses"
                aria-label="Search courses"
                className="w-full border-none bg-transparent py-2 text-sm text-foreground-950 placeholder:text-foreground-400 focus:outline-none"
              />
              <button
                type="submit"
                className="whitespace-nowrap rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50 hover:bg-primary-600"
              >
                Search
              </button>
            </form>
          </div>
        ) : null}
      </div>

      {mobileOpen ? (
        <div className="max-h-[calc(100vh-4rem)] overflow-y-auto border-b border-background-200 bg-background-50 lg:hidden">
          <nav className="site-container py-4" aria-label="Mobile navigation">
            <ul className="space-y-1">
              {navigation.map((item) => (
                <li key={item.label} className="border-b border-background-100 last:border-none">
                  {item.children || item.columns ? (
                    <div>
                      <button
                        type="button"
                        onClick={() => setOpenAccordion(openAccordion === item.label ? null : item.label)}
                        aria-expanded={openAccordion === item.label}
                        className="flex w-full items-center justify-between py-3 text-left text-sm font-medium text-foreground-900"
                      >
                        {item.label}
                        <i
                          className={
                            openAccordion === item.label
                              ? "ri-subtract-line text-lg text-primary-600"
                              : "ri-add-line text-lg text-foreground-500"
                          }
                          aria-hidden="true"
                        />
                      </button>
                      {openAccordion === item.label ? (
                        <div className="pb-3">
                          {item.to ? (
                            <Link to={item.to} className="block py-2 text-sm font-medium text-primary-600">
                              {item.label}
                            </Link>
                          ) : null}
                          {item.columns
                            ? item.columns.map((column) => (
                                <div key={column.title} className="mt-2">
                                  <p className="font-label text-[11px] font-semibold uppercase tracking-wider text-primary-600">
                                    {column.title}
                                  </p>
                                  <ul className="mt-1 space-y-1">
                                    {column.links.map((link) => (
                                      <li key={link.to}>
                                        <Link to={link.to} className="block py-1.5 text-sm text-foreground-600">
                                          {link.label}
                                        </Link>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ))
                            : (item.children ?? []).map((child) => (
                                <Link key={child.to} to={child.to} className="block py-2 text-sm text-foreground-600">
                                  {child.label}
                                </Link>
                              ))}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <Link to={item.to ?? "/"} className="block py-3 text-sm font-medium text-foreground-900">
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-col gap-3">
              <Link
                to="/enroll-now"
                className="rounded-md bg-primary-500 px-5 py-3 text-center text-sm font-semibold text-background-50"
              >
                Enroll Now
              </Link>
              <Link
                to={account.to}
                className="rounded-md border border-background-300 px-5 py-3 text-center text-sm font-semibold text-foreground-800"
              >
                {account.label}
              </Link>
            </div>
          </nav>
        </div>
      ) : null}
    </header>
  );
}

export default function SiteHeader() {
  const { data } = usePublicSite();
  return <SiteHeaderView navigation={data.navigation} settings={data.settings} />;
}
