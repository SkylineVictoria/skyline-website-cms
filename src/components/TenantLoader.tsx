import { useState, type CSSProperties } from "react";
import "./TenantLoader.css";
import { readCachedBrand, safeLogo, tenantBrandKey, normaliseBrand, type TenantBrand } from "@/lib/brandCache";
import { DEFAULT_PRIMARY_HEX, isHexColour } from "@/lib/colour";

// The helpers live in lib/brandCache so non-component code can use them without loading the loader; re-exported for convenience.
// eslint-disable-next-line react-refresh/only-export-components -- re-export of the brand cache helpers
export { cacheBrand, readCachedBrand, tenantBrandKey, type TenantBrand } from "@/lib/brandCache";

interface TenantLoaderProps {
  /** Overrides the cached brand (for example once the tenant has loaded). */
  brand?: Partial<TenantBrand>;
  /** Fades the loader out; used while the page underneath is already rendered. */
  leaving?: boolean;
  error?: boolean;
  onRetry?: () => void;
  /** Renders inside its parent (CMS theme preview) instead of covering the screen. */
  embedded?: boolean;
}

export default function TenantLoader({ brand, leaving = false, error = false, onRetry, embedded = false }: TenantLoaderProps) {
  const [cached] = useState(() => (embedded ? null : readCachedBrand()));
  const [logoFailed, setLogoFailed] = useState(false);
  const merged = normaliseBrand({ ...(cached ?? {}), ...(brand ?? {}) });
  const primary = isHexColour(brand?.primary) ? brand.primary : cached?.primary ?? DEFAULT_PRIMARY_HEX;
  const logo = safeLogo(brand?.logoUrl) || merged.logoUrl;
  const name = merged.name;
  const initial = (name || tenantBrandKey().replace(/^www\./, "")).charAt(0).toUpperCase() || "•";

  return (
    <div className={`tl-root tl-style-${merged.loaderStyle}${leaving ? " tl-leave" : ""}${embedded ? " tl-embedded" : ""}`} role={embedded ? "img" : "status"} aria-label={embedded ? "Loader preview" : undefined} aria-live={embedded ? undefined : "polite"} style={{ "--tl-primary": primary, "--tl-accent": merged.accent } as CSSProperties}>
      <div className="tl-glow" aria-hidden="true" />
      <div className="tl-card">
        <div className="tl-logo-wrap">
          {!error ? <span className="tl-ring" aria-hidden="true" /> : null}
          <div className="tl-logo">
            {logo && !logoFailed ? <img src={logo} alt="" decoding="async" referrerPolicy="no-referrer" onError={() => setLogoFailed(true)} /> : <span className="tl-mono" aria-hidden="true">{initial}</span>}
          </div>
        </div>
        {name ? <p className="tl-name">{name}</p> : null}
        <p className="tl-label">{error ? "Website unavailable" : "Loading"}</p>
        {error ? (
          <button type="button" className="tl-retry" onClick={onRetry}>Try again</button>
        ) : (
          <>
            <div className="tl-bar" aria-hidden="true"><span /></div>
            <div className="tl-dots" aria-hidden="true"><span /><span /><span /></div>
          </>
        )}
      </div>
    </div>
  );
}
