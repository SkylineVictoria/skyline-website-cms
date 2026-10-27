import { useState, type FormEvent } from "react";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, MediaUrlInput, PageHeader, Select, TextInput, Toggle } from "@/pages/admin/components/ui";
import ThemeSection from "@/pages/admin/components/ThemeSection";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminSettings } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import { SOCIAL_PLATFORMS, isKnownPlatform, socialIconFor } from "@/lib/socialPlatforms";
import SenderSettings from "@/pages/admin/components/SenderSettings";
import EventRecipients from "@/pages/admin/components/EventRecipients";
import { useAuth } from "@/pages/admin/lib/authContext";
import { MIN_PASSWORD_LENGTH, passwordProblem } from "@/lib/passwords";

export default function SettingsPage() {
  const { data, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const draftApi = useDraft<AdminSettings>("settings", "settings", data.settings);
  const draft = draftApi.value;
  const setDraft = draftApi.setValue;
  const [saving, setSaving] = useState(false);
  const { verifyAndChangePassword } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);

  const set = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  /* ------------------------------------------------------------- social */

  const setSocial = (index: number, patch: Partial<AdminSettings["social"][number]>) =>
    set("social", draft.social.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const moveSocial = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= draft.social.length) return;
    const next = [...draft.social];
    [next[index], next[target]] = [next[target], next[index]];
    set("social", next);
  };

  const removeSocial = (index: number) => set("social", draft.social.filter((_, i) => i !== index));

  const addSocial = () =>
    set("social", [
      ...draft.social,
      { id: `social-${Date.now()}`, label: "Facebook", href: "", icon: socialIconFor("Facebook"), enabled: true },
    ]);

  /* ---------------------------------------------------- homepage images */

  const setHero = (index: number, value: string) =>
    set("homeHeroImages", draft.homeHeroImages.map((x, i) => (i === index ? value : x)));
  const removeHero = (index: number) =>
    set("homeHeroImages", draft.homeHeroImages.filter((_, i) => i !== index));
  const addHero = () => set("homeHeroImages", [...draft.homeHeroImages, ""]);

  const save = async () => {
    if (!draft.name.trim()) { push("Website name is required.", "error"); return; }
    const missing = draft.social.find((item) => item.enabled && !item.href.trim());
    if (missing) {
      push(`Add a profile URL for ${missing.label} (or turn it off) before saving.`, "error");
      return;
    }
    const badUrl = draft.social.find(
      (item) => item.enabled && item.href.trim() && !/^https?:\/\//i.test(item.href.trim()),
    );
    if (badUrl) {
      push(`The ${badUrl.label} URL should start with https://.`, "error");
      return;
    }
    setSaving(true);
    try {
      // Awaits the actual Supabase write — the form is only reported as saved
      // when the database really accepted the change.
      await saveNow((d) => ({ ...d, settings: draft }));
      draftApi.markSaved();
      recordRevision({ entity: "settings", entityId: "settings", title: "Website Settings", action: "Saved draft", status: "Draft", snapshot: draft });
      logActivity("Updated", "Website settings", "Settings");
      push("Website settings saved");
    } catch (e) {
      push(e instanceof Error ? e.message : "Could not save settings. Please try again.", "error");
    } finally {
      setSaving(false);
    }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!currentPassword) { push("Enter your current password.", "error"); return; }
    const problem = passwordProblem(newPassword, confirmPassword);
    if (problem) { push(problem, "error"); return; }
    setPasswordBusy(true);
    const result = await verifyAndChangePassword(currentPassword, newPassword);
    setPasswordBusy(false);
    if (!result.ok) { push(result.error ?? "Could not change password.", "error"); return; }
    setCurrentPassword(""); setNewPassword(""); setConfirmPassword(""); push("Password changed.");
  };

  const platformOptions = (label: string): string[] => {
    const known = SOCIAL_PLATFORMS.map((p) => p.label);
    return isKnownPlatform(label) || !label ? known : [...known, label];
  };

  return (
    <div>
      <PageHeader
        title="Website Settings"
        description="The site identity used across header, footer, SEO and structured data. Set once — every page updates."
        breadcrumb="Global"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DraftStatus draft={draftApi} />
            <HistoryButton entity="settings" entityId="settings" title="Website Settings" onRestore={(snap) => setDraft(snap as AdminSettings)} />
            <Button icon="ri-save-line" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <ThemeSection value={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <Card className="p-5">
          <h2 className="mb-1 font-heading text-base font-semibold text-foreground-950">Change password</h2>
          <p className="mb-4 text-sm text-foreground-500">Confirm your current password before choosing a new one.</p>
          <form onSubmit={changePassword} className="space-y-4">
            <Field label="Current password" required><TextInput type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" /></Field>
            <Field label="New password" required hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}><TextInput type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" /></Field>
            <Field label="Confirm new password" required><TextInput type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} autoComplete="new-password" /></Field>
            <Button type="submit" disabled={passwordBusy}>{passwordBusy ? "Updating…" : "Change password"}</Button>
          </form>
        </Card>
        <Card className="p-5">
          <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Identity</h2>
          <div className="space-y-4">
            <Field label="Institute name">
              <TextInput value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Short name" hint="Used in compact places like the admin header.">
              <TextInput value={draft.shortName} onChange={(e) => set("shortName", e.target.value)} />
            </Field>
            <MediaUrlInput
              label="Logo"
              value={draft.logo}
              onChange={(v) => set("logo", v)}
              hint="Paste a logo URL or upload an image file. Leave empty to use the text logo."
            />
            <MediaUrlInput
              label="Favicon"
              value={draft.favicon}
              onChange={(v) => set("favicon", v)}
              hint="Shown in the browser tab. Uploaded to storage, applied on the live site instantly."
            />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Legal &amp; registration</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="RTO number">
              <TextInput value={draft.rto} onChange={(e) => set("rto", e.target.value)} />
            </Field>
            <Field label="CRICOS code">
              <TextInput value={draft.cricos} onChange={(e) => set("cricos", e.target.value)} />
            </Field>
          </div>
          <div className="mt-4">
            <Field label="Student portal sign-in URL">
              <TextInput value={draft.signInUrl} onChange={(e) => set("signInUrl", e.target.value)} />
            </Field>
          </div>
        </Card>

        {/* Homepage imagery — Issue 1 */}
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground-950">Homepage images</h2>
              <p className="mt-1 text-sm text-foreground-500">
                The hero slideshow and the About image shown on the homepage. Images appear instantly with no redeploy.
              </p>
            </div>
            <Button variant="outline" size="sm" icon="ri-add-line" onClick={addHero}>
              Add hero image
            </Button>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              {draft.homeHeroImages.length === 0 ? (
                <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                  No hero images. The default slideshow will be shown.
                </p>
              ) : (
                draft.homeHeroImages.map((image, index) => (
                  <div key={`hero-${index}`} className="flex items-start gap-2">
                    <div className="flex-1">
                      <MediaUrlInput
                        label={`Hero image ${index + 1}`}
                        value={image}
                        onChange={(v) => setHero(index, v)}
                        hint="Recommended 16:9, at least 1920×1080."
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeHero(index)}
                      aria-label="Remove hero image"
                      className="mt-6 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-background-300 text-foreground-500 hover:bg-background-100"
                    >
                      <i className="ri-delete-bin-line" aria-hidden="true" />
                    </button>
                  </div>
                ))
              )}
            </div>
            <div>
              <MediaUrlInput
                label="About section image"
                value={draft.homeAboutImage}
                onChange={(v) => set("homeAboutImage", v)}
                hint="Shown beside the “A Few Words About the Skyline” section."
              />
            </div>
          </div>
        </Card>

        {/* Social profiles — Issue 8 */}
        <Card className="p-5 xl:col-span-2">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="font-heading text-base font-semibold text-foreground-950">Social profiles</h2>
              <p className="mt-1 text-sm text-foreground-500">
                Select a platform to auto-assign its icon, set the profile URL and reorder. Disabled profiles are hidden on
                the website.
              </p>
            </div>
            <Button variant="outline" size="sm" icon="ri-add-line" onClick={addSocial}>
              Add profile
            </Button>
          </div>
          <div className="space-y-3">
            {draft.social.map((social, index) => (
              <div
                key={social.id}
                className="grid grid-cols-1 gap-2 rounded-md border border-background-200 p-3 md:grid-cols-[28px_auto_200px_1fr_auto_auto] md:items-center"
              >
                <div className="flex md:flex-col">
                  <button
                    type="button"
                    onClick={() => moveSocial(index, -1)}
                    aria-label="Move up"
                    className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                  >
                    <i className="ri-arrow-up-s-fill" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveSocial(index, 1)}
                    aria-label="Move down"
                    className="flex h-5 w-5 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                  >
                    <i className="ri-arrow-down-s-fill" aria-hidden="true" />
                  </button>
                </div>
                <span className="flex h-9 w-9 items-center justify-center rounded-md bg-primary-100 text-primary-700">
                  <i className={`${social.icon || socialIconFor(social.label)} text-lg`} aria-hidden="true" />
                </span>
                <Select
                  value={social.label}
                  aria-label="Platform"
                  onChange={(e) => setSocial(index, { label: e.target.value, icon: socialIconFor(e.target.value) })}
                >
                  {platformOptions(social.label).map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </Select>
                <TextInput
                  value={social.href}
                  placeholder="https://…"
                  onChange={(e) => setSocial(index, { href: e.target.value })}
                />
                <Toggle
                  checked={social.enabled}
                  onChange={(v) => setSocial(index, { enabled: v })}
                  label="Enabled"
                />
                <button
                  type="button"
                  onClick={() => removeSocial(index)}
                  aria-label="Remove profile"
                  className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
                >
                  <i className="ri-delete-bin-line" aria-hidden="true" />
                </button>
              </div>
            ))}
            {draft.social.length === 0 ? (
              <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                No social profiles configured.
              </p>
            ) : null}
          </div>
        </Card>

        <div className="space-y-5 xl:col-span-2"><SenderSettings tenantId={null} /><EventRecipients tenantId={null} /></div>
      </div>

      <div className="mt-5 flex justify-end">
        <Button icon="ri-save-line" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </div>
  );
}
