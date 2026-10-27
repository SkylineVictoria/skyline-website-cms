import { useState } from "react";
import type { AdminSettings } from "@/pages/admin/lib/types";
import { Button, Card, Field, Select, TextInput } from "@/pages/admin/components/ui";
import TenantLoader from "@/components/TenantLoader";
import { tenantThemeStyle } from "@/lib/tenantTheme";
import { contrastLevel, contrastWithWhite, DEFAULT_ACCENT_HEX, DEFAULT_PRIMARY_HEX, isHexColour, normaliseHex } from "@/lib/colour";
import { LOADER_STYLES, type LoaderStyle } from "@/config/cmsLimits";

const FONTS = ["Arial", "Georgia", "Verdana", "system-ui"];
const STYLE_LABEL: Record<LoaderStyle, string> = { ring: "Ring around the logo", bar: "Progress bar", dots: "Bouncing dots" };

function ColourField({ label, value, fallback, onCommit, onClear }: { label: string; value: string; fallback: string; onCommit: (hex: string) => void; onClear?: () => void }) {
  const [text, setText] = useState(value);
  const [shown, setShown] = useState(value);
  if (value !== shown) { setShown(value); setText(value); } // follow external changes (reset, restored draft)
  const parsed = normaliseHex(text);
  return (
    <Field label={label} hint={text && !parsed ? "Enter a hex colour such as #ea6619." : undefined}>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`${label} picker`} value={isHexColour(value) ? value : fallback} onChange={(e) => onCommit(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-background-300 bg-background-50 p-0.5" />
        <TextInput aria-label={`${label} hex`} className="max-w-[140px] font-mono" value={text} maxLength={7} placeholder={fallback}
          onChange={(e) => { setText(e.target.value); const next = normaliseHex(e.target.value); if (next) onCommit(next); }} />
        {onClear ? <Button variant="ghost" size="sm" onClick={onClear}>None</Button> : null}
      </div>
    </Field>
  );
}

/** Website Settings > Theme: primary and accent colours, fonts and loader style, with a contrast check, live previews and a reset. */
export default function ThemeSection({ value, onChange }: { value: AdminSettings; onChange: (patch: Partial<AdminSettings>) => void }) {
  const primary = value.themeConfigured && isHexColour(value.primaryColor) ? value.primaryColor : DEFAULT_PRIMARY_HEX;
  const accent = value.accentColor && isHexColour(value.accentColor) ? value.accentColor : "";
  const style = (LOADER_STYLES as readonly string[]).includes(value.loaderStyle ?? "") ? (value.loaderStyle as LoaderStyle) : "ring";
  const level = contrastLevel(primary);
  const ratio = contrastWithWhite(primary).toFixed(1);
  const patch = (next: Partial<AdminSettings>) => onChange({ ...next, themeConfigured: true });
  const previewTheme = { primaryColor: primary, accentColor: accent || undefined, headingFont: value.headingFont ?? "Arial", bodyFont: value.bodyFont ?? "Arial" };

  return (
    <Card className="p-5 xl:col-span-2">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-heading text-base font-semibold">Website theme</h2>
        <Button variant="outline" size="sm" onClick={() => onChange({ themeConfigured: false, primaryColor: DEFAULT_PRIMARY_HEX, accentColor: "", loaderStyle: "ring", headingFont: "Arial", bodyFont: "Arial" })}>Reset to default</Button>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <ColourField label="Primary colour" value={primary} fallback={DEFAULT_PRIMARY_HEX} onCommit={(hex) => patch({ primaryColor: hex })} />
          <p role="status" className={`text-xs ${level === "good" ? "text-foreground-500" : "font-medium text-primary-800"}`}>
            White text on this colour has a contrast ratio of {ratio}:1.{" "}
            {level === "good" ? "That passes for body text." : level === "large-only" ? "Below 4.5:1: fine for large text and buttons, but small white text may be hard to read." : "Below 3:1: white text will be hard to read. Choose a darker colour."}
          </p>
          <ColourField label="Accent colour (optional)" value={accent} fallback={DEFAULT_ACCENT_HEX} onCommit={(hex) => patch({ accentColor: hex })} onClear={() => patch({ accentColor: "" })} />
          {(["headingFont", "bodyFont"] as const).map((key) => (
            <Field key={key} label={key === "headingFont" ? "Heading font" : "Body font"}>
              <Select aria-label={key === "headingFont" ? "Heading font" : "Body font"} value={value[key] ?? "Arial"} onChange={(e) => patch({ [key]: e.target.value })}>
                {FONTS.map((font) => <option key={font}>{font}</option>)}
              </Select>
            </Field>
          ))}
          <Field label="Loading animation">
            <Select aria-label="Loading animation" value={style} onChange={(e) => patch({ loaderStyle: e.target.value })}>
              {LOADER_STYLES.map((s) => <option key={s} value={s}>{STYLE_LABEL[s]}</option>)}
            </Select>
          </Field>
        </div>

        <div className="space-y-4">
          <div className="overflow-hidden rounded-md border border-background-200" style={tenantThemeStyle(previewTheme)}>
            <div className="bg-background-50 p-4 font-body">
              <p className="font-heading text-sm font-semibold text-foreground-950">Site preview</p>
              <p className="mt-1 text-sm text-foreground-600">Links and <span className="font-medium text-primary-600">highlights</span> use the primary colour.</p>
              <span className="mt-3 inline-block rounded-md bg-primary-500 px-4 py-2 text-sm font-semibold text-background-50">Enroll Now</span>
            </div>
            <div className="bg-accent-950 px-4 py-3 text-xs text-background-200">Footer band <span className="text-primary-300">link</span></div>
          </div>
          <div aria-label="Loader preview">
            <TenantLoader embedded brand={{ name: value.name, logoUrl: value.logo, primary, accent: accent || DEFAULT_ACCENT_HEX, loaderStyle: style }} />
          </div>
        </div>
      </div>
    </Card>
  );
}
