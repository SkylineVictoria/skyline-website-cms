import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Button, Card, Field, PageHeader, TextInput } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminSettings } from "@/pages/admin/lib/types";
import { HistoryButton } from "@/pages/admin/components/workflow";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";

export default function ContactPage() {
  const { data, update, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();
  const draftApi = useDraft<AdminSettings>("contact", "contact", data.settings);
  const draft = draftApi.value;
  const setDraft = draftApi.setValue;

  const set = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    update((d) => ({ ...d, settings: draft }));
    draftApi.markSaved();
    recordRevision({ entity: "contact", entityId: "contact", title: "Contact Information", action: "Saved draft", status: "Draft", snapshot: draft });
    logActivity("Updated", "Contact information", "Contact");
    push("Contact information saved");
  };

  return (
    <div>
      <PageHeader
        title="Contact Information"
        description="Phone, email and address shown in the header, footer, contact page and structured data."
        breadcrumb="Global"
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <DraftStatus draft={draftApi} />
            <HistoryButton entity="contact" entityId="contact" title="Contact Information" onRestore={(snap) => setDraft(snap as AdminSettings)} />
            <Button icon="ri-save-line" onClick={save}>Save changes</Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Contact details</h2>
          <div className="space-y-4">
            <Field label="Main phone">
              <TextInput value={draft.phone} onChange={(e) => set("phone", e.target.value)} />
            </Field>
            <Field label="General enquiries email">
              <TextInput value={draft.email} onChange={(e) => set("email", e.target.value)} />
            </Field>
            <Field label="Admissions email">
              <TextInput value={draft.admissionsEmail} onChange={(e) => set("admissionsEmail", e.target.value)} />
            </Field>
            <Field label="Street address">
              <TextInput value={draft.address} onChange={(e) => set("address", e.target.value)} />
            </Field>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Map preview</h2>
          <div className="h-56 w-full overflow-hidden rounded-md border border-background-200">
            <iframe
              title="Location map"
              src={`https://maps.google.com/maps?q=${encodeURIComponent(draft.address)}&t=m&z=14&output=embed&iwloc=near`}
              className="h-full w-full"
            />
          </div>
          <p className="mt-3 text-xs text-foreground-500">
            The map updates automatically from the address above.
          </p>
        </Card>
      </div>

      <div className="mt-5 flex justify-end">
        <Button icon="ri-save-line" onClick={save}>
          Save changes
        </Button>
      </div>
    </div>
  );
}