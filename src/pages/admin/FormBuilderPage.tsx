import { useMemo, useState } from "react";
import DraftStatus from "@/pages/admin/components/DraftStatus";
import { useDraft } from "@/pages/admin/lib/useDraft";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { useAuth } from "@/pages/admin/lib/authContext";
import { requestWebsiteDomain } from "@/lib/tenantHost";
import { Button, Card, Field, SectionTabs, Select, StatusBadge, TextArea, TextInput, Toggle } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { AdminForm, AdminFormField, FieldType } from "@/pages/admin/lib/types";
import { WorkflowActions } from "@/pages/admin/components/workflow";
import FormFieldControl from "@/components/feature/FormFieldControl";
import {
  FORM_FIELD_TYPES,
  supportsOptions as fieldSupportsOptions,
  supportsDefault as fieldSupportsDefault,
  type RenderField,
} from "@/lib/formFields";

const FIELD_TYPES: FieldType[] = FORM_FIELD_TYPES;

const TABS = [
  { id: "fields", label: "Fields", icon: "ri-list-check-2" },
  { id: "settings", label: "Settings", icon: "ri-settings-3-line" },
  { id: "preview", label: "Preview", icon: "ri-eye-line" },
];

const isOptionType = (type: FieldType): boolean => fieldSupportsOptions(type);
const supportsDefaultOption = (type: FieldType): boolean => fieldSupportsDefault(type);

/** Reusable option builder: add, edit, delete, reorder. */
function OptionsEditor({
  label,
  options,
  onChange,
}: {
  label: string;
  options: string[];
  onChange: (next: string[]) => void;
}) {
  const prefix = label.toLowerCase().includes("column") ? "Column" : "Option";
  const add = () => onChange([...options, `${prefix} ${options.length + 1}`]);
  const update = (index: number, value: string) => onChange(options.map((o, i) => (i === index ? value : o)));
  const remove = (index: number) => onChange(options.filter((_, i) => i !== index));
  const move = (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= options.length) return;
    const next = [...options];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[13px] font-medium text-foreground-800">{label}</span>
        <button
          type="button"
          onClick={add}
          className="inline-flex cursor-pointer items-center gap-1 text-[13px] font-medium text-primary-600 hover:underline"
        >
          <i className="ri-add-line" aria-hidden="true" />
          Add option
        </button>
      </div>
      {options.length === 0 ? (
        <p className="rounded-md border border-dashed border-background-300 px-3 py-4 text-center text-xs text-foreground-500">
          No options yet. Add the first one.
        </p>
      ) : (
        <div className="space-y-2">
          {options.map((option, index) => (
            <div key={`opt-${index}`} className="flex items-center gap-2">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(index, -1)}
                  aria-label="Move option up"
                  className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                >
                  <i className="ri-arrow-up-s-fill text-sm" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => move(index, 1)}
                  aria-label="Move option down"
                  className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600"
                >
                  <i className="ri-arrow-down-s-fill text-sm" aria-hidden="true" />
                </button>
              </div>
              <TextInput value={option} onChange={(e) => update(index, e.target.value)} className="flex-1" />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label="Remove option"
                className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
              >
                <i className="ri-delete-bin-line" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FieldPreview({ field }: { field: AdminFormField }) {
  // Rendered with the SAME component the public website uses, so the preview
  // can never disagree with the live form (e.g. Radio renders radio buttons).
  const render: RenderField = {
    id: field.id,
    label: field.label,
    type: field.type,
    required: field.required,
    help: field.help,
    options: field.options,
    visible: field.visible,
    placeholder: field.placeholder,
    defaultValue: field.defaultValue,
    maxLength: field.maxLength,
    min: field.min,
    max: field.max,
    step: field.step,
    fileTypes: field.fileTypes,
    maxSizeMb: field.maxSizeMb,
    rows: field.rows,
  };
  return <FormFieldControl field={render} disabled idPrefix="preview" />;
}

export default function FormBuilderPage() {
  const { user } = useAuth();
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, saveNow, logActivity, recordRevision } = useAdminData();
  const { push } = useToast();

  const original = useMemo(() => data.forms.find((f) => f.id === id), [data.forms, id]);
  const draftApi = useDraft<AdminForm | null>("form", id ?? "new", original ?? null);
  const draft = draftApi.value;
  const setDraft = draftApi.setValue;
  const [tab, setTab] = useState("fields");
  const [activeField, setActiveField] = useState<string | null>(null);
  const dirty = draftApi.dirty;

  if (!original || !draft) {
    return (
      <Card className="p-8 text-center">
        <p className="font-heading text-lg font-semibold text-foreground-900">Form not found</p>
        <div className="mt-4">
          <Button variant="outline" onClick={() => navigate("/admin/forms")}>
            Back to Forms
          </Button>
        </div>
      </Card>
    );
  }

  const set = <K extends keyof AdminForm>(key: K, value: AdminForm[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const setField = (fid: string, patch: Partial<AdminFormField>) => {
    set("fields", draft.fields.map((f) => (f.id === fid ? { ...f, ...patch } : f)));
  };

  const toNum = (value: string): number | undefined => {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  const addField = () => {
    const f: AdminFormField = { id: `field-${Date.now()}`, label: "New field", type: "Text", required: false, help: "", options: [], visible: true };
    set("fields", [...draft.fields, f]);
    setActiveField(f.id);
  };

  const removeField = (fid: string) => {
    set("fields", draft.fields.filter((f) => f.id !== fid));
    if (activeField === fid) setActiveField(null);
  };

  const move = (fid: string, dir: -1 | 1) => {
    const idx = draft.fields.findIndex((f) => f.id === fid);
    const target = idx + dir;
    if (target < 0 || target >= draft.fields.length) return;
    const next = [...draft.fields];
    [next[idx], next[target]] = [next[target], next[idx]];
    set("fields", next);
  };

  const save = async (publish?: boolean) => {
    if (!draft) return;
    const next = {
      ...draft,
      status: publish === undefined ? draft.status : publish ? "Published" : "Draft",
      updatedAt: "2026-10-12 09:14",
    } as AdminForm;
    try {
    await saveNow((d) => ({ ...d, forms: d.forms.map((f) => (f.id === next.id ? next : f)) }));
    recordRevision({
      entity: "form",
      entityId: next.id,
      title: next.name,
      action: publish === undefined ? "Updated" : publish ? "Published" : "Saved draft",
      status: next.status,
      snapshot: next,
    });
    logActivity(publish === undefined ? "Updated" : publish ? "Published" : "Saved draft", next.name, "Forms");
    draftApi.markSaved(next);
    push(publish === undefined ? "Form saved" : publish ? "Form published" : "Draft saved");
    } catch (e) { push(e instanceof Error ? e.message : "Form save failed", "error"); }
  };

  const current = draft.fields.find((f) => f.id === activeField) ?? null;

  return (
    <div>
      <div className="mb-5 flex flex-col gap-3 border-b border-background-200 pb-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Link to="/admin/forms" className="mb-1 inline-flex items-center gap-1 text-[13px] font-medium text-foreground-500 hover:text-primary-600">
            <i className="ri-arrow-left-line" aria-hidden="true" />
            Forms
          </Link>
          <h1 className="font-heading text-xl font-bold text-foreground-950">{draft.name}</h1>
          <div className="mt-1.5 flex items-center gap-2">
            <StatusBadge status={draft.status} />
            <DraftStatus draft={draftApi} />
          </div>
        </div>
        <WorkflowActions
          entity="form"
          entityId={draft.id}
          title={draft.name}
          dirty={dirty}
          onSaveDraft={() => save(false)}
          onPublish={() => save(true)}
          onRestore={(snap) => {
            setDraft(snap as AdminForm);
          }}
        />
      </div>

      <SectionTabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "fields" ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-[1fr_380px]">
          <Card className="p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-heading text-base font-semibold text-foreground-950">Form fields</h2>
              <Button variant="outline" size="sm" icon="ri-add-line" onClick={addField}>
                Add field
              </Button>
            </div>
            <div className="space-y-2">
              {draft.fields.map((f) => (
                <div
                  key={f.id}
                  className={`flex items-center gap-2 rounded-md border p-3 ${activeField === f.id ? "border-primary-400 bg-primary-50" : "border-background-200"}`}
                >
                  <div className="flex flex-col">
                    <button type="button" onClick={() => move(f.id, -1)} aria-label="Move up" className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600">
                      <i className="ri-arrow-up-s-fill text-sm" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => move(f.id, 1)} aria-label="Move down" className="flex h-4 w-4 cursor-pointer items-center justify-center text-foreground-400 hover:text-primary-600">
                      <i className="ri-arrow-down-s-fill text-sm" aria-hidden="true" />
                    </button>
                  </div>
                  <i className="ri-drag-move-2-line text-foreground-300" aria-hidden="true" />
                  <button type="button" onClick={() => setActiveField(f.id)} className="flex-1 cursor-pointer text-left">
                    <span className="text-[13px] font-medium text-foreground-900">{f.label}</span>
                    <span className="ml-2 text-xs text-foreground-500">{f.type}</span>
                    {f.required ? <span className="ml-2 text-xs text-primary-600">required</span> : null}
                  </button>
                  {!f.visible ? <i className="ri-eye-off-line text-foreground-400" aria-hidden="true" /> : null}
                  <button type="button" onClick={() => removeField(f.id)} aria-label="Remove" className="flex h-7 w-7 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-100">
                    <i className="ri-delete-bin-line" aria-hidden="true" />
                  </button>
                </div>
              ))}
              {draft.fields.length === 0 ? (
                <p className="rounded-md border border-dashed border-background-300 px-4 py-6 text-center text-sm text-foreground-500">
                  No fields yet. Add your first field.
                </p>
              ) : null}
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 font-heading text-base font-semibold text-foreground-950">Field settings</h2>
            {current ? (
              <div className="space-y-4">
                <Field label="Label" required>
                  <TextInput value={current.label} onChange={(e) => setField(current.id, { label: e.target.value })} />
                </Field>
                <Field label="Field type">
                  <Select value={current.type} onChange={(e) => setField(current.id, { type: e.target.value as FieldType })}>
                    {FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Helper text">
                  <TextInput value={current.help} onChange={(e) => setField(current.id, { help: e.target.value })} placeholder="Shown under the field" />
                </Field>
                {isOptionType(current.type) ? (
                  <OptionsEditor
                    label={current.type === "Table" ? "Column headers" : "Options"}
                    options={current.options}
                    onChange={(next) => setField(current.id, { options: next })}
                  />
                ) : null}

                {supportsDefaultOption(current.type) && current.options.length > 0 ? (
                  <Field label="Default selection">
                    <Select
                      value={current.defaultValue ?? ""}
                      onChange={(e) => setField(current.id, { defaultValue: e.target.value })}
                    >
                      <option value="">None</option>
                      {current.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ) : null}

                {current.type === "Checkbox" && current.options.length === 0 ? (
                  <div className="rounded-md border border-background-200 p-3">
                    <Toggle
                      checked={current.defaultValue === "true"}
                      onChange={(v) => setField(current.id, { defaultValue: v ? "true" : "" })}
                      label="Checked by default"
                    />
                    <p className="mt-1.5 text-xs text-foreground-500">
                      A standalone checkbox — its label above is the text shown next to the box.
                    </p>
                  </div>
                ) : null}

                {(current.type === "Text" ||
                  current.type === "Textarea" ||
                  current.type === "Email" ||
                  current.type === "Phone") ? (
                  <>
                    <Field label="Placeholder">
                      <TextInput
                        value={current.placeholder ?? ""}
                        onChange={(e) => setField(current.id, { placeholder: e.target.value })}
                        placeholder="Shown inside the field"
                      />
                    </Field>
                    {current.type === "Textarea" ? (
                      <Field label="Rows" hint="How tall the multiline box is.">
                        <TextInput
                          type="number"
                          min={2}
                          max={20}
                          value={current.rows ?? ""}
                          onChange={(e) => setField(current.id, { rows: toNum(e.target.value) })}
                        />
                      </Field>
                    ) : null}
                    <Field label="Maximum characters" hint="Leave empty for no limit.">
                      <TextInput
                        type="number"
                        min={1}
                        value={current.maxLength ?? ""}
                        onChange={(e) => setField(current.id, { maxLength: toNum(e.target.value) })}
                      />
                    </Field>
                  </>
                ) : null}

                {current.type === "Number" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Minimum">
                      <TextInput type="number" value={current.min ?? ""} onChange={(e) => setField(current.id, { min: e.target.value })} />
                    </Field>
                    <Field label="Maximum">
                      <TextInput type="number" value={current.max ?? ""} onChange={(e) => setField(current.id, { max: e.target.value })} />
                    </Field>
                    <Field label="Step">
                      <TextInput type="number" value={current.step ?? ""} onChange={(e) => setField(current.id, { step: e.target.value })} />
                    </Field>
                  </div>
                ) : null}

                {current.type === "Date" ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Earliest date">
                      <TextInput type="date" value={current.min ?? ""} onChange={(e) => setField(current.id, { min: e.target.value })} />
                    </Field>
                    <Field label="Latest date">
                      <TextInput type="date" value={current.max ?? ""} onChange={(e) => setField(current.id, { max: e.target.value })} />
                    </Field>
                  </div>
                ) : null}

                {current.type === "File Upload" ? (
                  <>
                    <Field label="Allowed file types" hint="Comma separated, e.g. pdf, jpg, png">
                      <TextInput value={current.fileTypes ?? ""} onChange={(e) => setField(current.id, { fileTypes: e.target.value })} />
                    </Field>
                    <Field label="Maximum size (MB)" hint="Subject to the backend upload limit.">
                      <TextInput
                        type="number"
                        min={1}
                        value={current.maxSizeMb ?? ""}
                        onChange={(e) => setField(current.id, { maxSizeMb: toNum(e.target.value) })}
                      />
                    </Field>
                  </>
                ) : null}
                <div className="flex flex-wrap items-center gap-6 border-t border-background-200 pt-4">
                  <Toggle checked={current.required} onChange={(v) => setField(current.id, { required: v })} label="Required" />
                  <Toggle checked={current.visible} onChange={(v) => setField(current.id, { visible: v })} label="Visible" />
                </div>
              </div>
            ) : (
              <p className="text-sm text-foreground-500">Select a field to edit its settings.</p>
            )}
          </Card>
        </div>
      ) : null}

      {tab === "settings" ? (
        <Card className="max-w-2xl p-5">
          <div className="space-y-4">
            {requestWebsiteDomain() ? <>
              <Field label="Public form submission endpoint" hint="Tenant administrators approve the public HTTPS endpoint. No credentials belong in this URL."><TextInput disabled={user?.role !== "Admin"} value={draft.submitUrl ?? ""} onChange={(e) => set("submitUrl", e.target.value)} /></Field>
              <Toggle label="Approved form submission endpoint" checked={draft.submissionApproved ?? false} onChange={(value) => { if (user?.role === "Admin") set("submissionApproved", value); }} />
            </> : null}
            <Field label="Form name" required>
              <TextInput value={draft.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Description">
              <TextArea rows={3} value={draft.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <Field label="Status">
              <Select value={draft.status} onChange={(e) => set("status", e.target.value as AdminForm["status"])}>
                <option value="Published">Published</option>
                <option value="Draft">Draft</option>
              </Select>
            </Field>
          </div>
        </Card>
      ) : null}

      {tab === "preview" ? (
        <Card className="max-w-2xl p-6">
          <h2 className="font-heading text-lg font-semibold text-foreground-950">{draft.name}</h2>
          <p className="mt-1 text-sm text-foreground-600">{draft.description}</p>
          <div className="mt-5 space-y-4">
            {draft.fields.filter((f) => f.visible).map((f) => (
              <FieldPreview key={f.id} field={f} />
            ))}
          </div>
          <div className="mt-6">
            <span className="inline-flex items-center gap-2 rounded-md bg-primary-500 px-4 py-2 text-sm font-medium text-background-50">
              Submit
            </span>
          </div>
          <p className="mt-3 text-xs text-foreground-400">Read-only preview of how this form appears on the website.</p>
        </Card>
      ) : null}
    </div>
  );
}
