import { Link } from "react-router-dom";
import { Card } from "@/pages/admin/components/ui";
import PresetsManager from "@/pages/admin/components/signing/PresetsManager";

/**
 * Letterhead (owner, 2026-11-28): the company letterheads sit with the other company settings on Settings & Policies ›
 * AVETMISS settings. The list is the same Header & footer presets as Documents & Signatures › Templates (signing_admin
 * part_list / part_save / part_delete); a template copies a preset with "Use preset", so editing one here leaves templates as they are.
 */
export default function LetterheadSettings() {
  return <Card className="space-y-3 p-5" data-testid="letterhead-settings">
    <div>
      <h2 className="text-lg font-semibold">Letterhead</h2>
      <p className="text-sm text-foreground-600">
        Company letterheads (header) and page footers for letters and documents. Pick one in a document template with
        "Use preset" (Documents &amp; Signatures › <Link className="font-medium text-primary-700 hover:underline" to="/admin/signing/templates">Templates</Link>).
        System PDFs (staff offer letters, signature pages, the submitted application) use the logo, name and colour from{" "}
        <Link className="font-medium text-primary-700 hover:underline" to="/admin/settings">Website Settings</Link>.
      </p>
    </div>
    <PresetsManager inline />
  </Card>;
}
