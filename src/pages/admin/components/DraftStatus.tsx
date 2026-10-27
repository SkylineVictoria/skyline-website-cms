import type { DraftApi } from "@/pages/admin/lib/useDraft";

/** Sits next to the Save button: "Unsaved changes" while dirty, plus the "draft restored" note with Discard after a restore. */
export default function DraftStatus({ draft }: { draft: Pick<DraftApi<unknown>, "dirty" | "restored" | "discard"> }) {
  if (!draft.dirty) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" role="status" aria-live="polite">
      {draft.restored ? (
        <span className="text-foreground-600">
          Unsaved draft restored.{" "}
          <button type="button" onClick={draft.discard} className="cursor-pointer font-medium text-primary-700 underline underline-offset-2 hover:text-primary-800">Discard</button>
        </span>
      ) : null}
      <span className="inline-flex items-center gap-1.5 font-medium text-primary-700">
        <span className="h-2 w-2 rounded-full bg-primary-500" aria-hidden="true" />
        Unsaved changes
      </span>
    </div>
  );
}
