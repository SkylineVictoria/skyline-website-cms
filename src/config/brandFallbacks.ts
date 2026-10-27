// Logos used only while a site has no logo configured in Website Settings (the legacy Skyline images). A configured logo always wins.
export const LEGACY_FOOTER_LOGO = "https://slit.edu.au/wp-content/uploads/2023/06/footer-logo.png";
export const LEGACY_ACKNOWLEDGEMENT_LOGO = "https://slit.edu.au/wp-content/uploads/2023/09/slit-c.png";

/** Footer logos for a settings logo: the configured one for both slots, else the legacy images for the legacy site and nothing for a tenant. */
export function footerLogos(configuredLogo: string, isTenant: boolean): { main: string; acknowledgement: string } {
  const logo = configuredLogo.trim();
  if (logo) return { main: logo, acknowledgement: logo };
  return isTenant ? { main: "", acknowledgement: "" } : { main: LEGACY_FOOTER_LOGO, acknowledgement: LEGACY_ACKNOWLEDGEMENT_LOGO };
}
