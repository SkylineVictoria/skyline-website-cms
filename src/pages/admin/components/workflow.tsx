import { useState } from "react";
import { Link } from "react-router-dom";
import { useAdminData } from "@/pages/admin/lib/storeContext";
import { Badge, Button, EmptyState, Modal, StatusBadge } from "@/pages/admin/components/ui";
import { useToast } from "@/pages/admin/components/toastContext";
import type { Revision, RevisionEntity } from "@/pages/admin/lib/types";

/* ------------------------------------------------------------ Snapshot view */

function SnapshotView({ snapshot }: { snapshot: unknown }) {
  if (!snapshot || typeof snapshot !== "object") {
    return <p className="text-sm text-foreground-500">No preview available for this version.</p>;
  }
  const entries = Object.entries(snapshot as Record<string, unknown>).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
  );
  if (entries.length === 0) {
    return <p className="text-sm text-foreground-500">No preview available for this version.</p>;
  }
  return (
    <dl className="divide-y divide-background-200 overflow-hidden rounded-md border border-background-200">
      {entries.slice(0, 14).map(([k, v]) => (
        <div key={k} className="grid grid-cols-[140px_1fr] gap-3 px-3 py-2 text-[13px]">
          <dt className="font-medium text-foreground-500">{k}</dt>
          <dd className="break-words text-foreground-900">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/* --------------------------------------------------------- Version history */

export function VersionHistoryModal({
  open,
  onClose,
  entity,
  entityId,
  title,
  onRestore,
}: {
  open: boolean;
  onClose: () => void;
  entity: RevisionEntity;
  entityId: string;
  title: string;
  onRestore?: (snapshot: unknown) => void;
}) {
  const { revisionsFor, restoreRevision } = useAdminData();
  const { push } = useToast();
  const [preview, setPreview] = useState<Revision | null>(null);
  const list = revisionsFor(entity, entityId);

  const restore = (r: Revision) => {
    restoreRevision(r.id);
    onRestore?.(r.snapshot);
    push("Version restored");
    onClose();
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={`Version history — ${title}`}
        width="max-w-2xl"
        footer={
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        }
      >
        {list.length === 0 ? (
          <EmptyState
            icon="ri-history-line"
            title="No versions yet"
            description="Save a draft or publish to start building version history for this item."
          />
        ) : (
          <ul className="space-y-2">
            {list.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 rounded-md border border-background-200 p-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-background-100 text-foreground-500">
                  <i className={i === 0 ? "ri-record-circle-line text-primary-600" : "ri-history-line"} aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-foreground-900">{r.action}</span>
                    <StatusBadge status={r.status} />
                    {i === 0 ? <Badge tone="secondary">Latest</Badge> : null}
                  </div>
                  <p className="mt-0.5 text-xs text-foreground-500">
                    {r.by} · {r.at}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" icon="ri-eye-line" onClick={() => setPreview(r)}>
                    View
                  </Button>
                  {i === 0 ? null : (
                    <Button variant="outline" size="sm" icon="ri-restart-line" onClick={() => restore(r)}>
                      Restore
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Modal>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title="Version snapshot"
        width="max-w-xl"
        footer={
          <Button variant="outline" onClick={() => setPreview(null)}>
            Close
          </Button>
        }
      >
        {preview ? <SnapshotView snapshot={preview.snapshot} /> : null}
      </Modal>
    </>
  );
}

/* ----------------------------------------------------------- History button */

export function HistoryButton({
  entity,
  entityId,
  title,
  onRestore,
}: {
  entity: RevisionEntity;
  entityId: string;
  title: string;
  onRestore?: (snapshot: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Version history"
        title="Version history"
        className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-foreground-500 hover:bg-background-100"
      >
        <i className="ri-history-line" aria-hidden="true" />
      </button>
      <VersionHistoryModal
        open={open}
        onClose={() => setOpen(false)}
        entity={entity}
        entityId={entityId}
        title={title}
        onRestore={onRestore}
      />
    </>
  );
}

/* ---------------------------------------------------------- Workflow actions */

export function WorkflowActions({
  entity,
  entityId,
  title,
  dirty,
  previewHref,
  onSaveDraft,
  onPublish,
  onRestore,
}: {
  entity: RevisionEntity;
  entityId: string;
  title: string;
  dirty?: boolean;
  previewHref?: string;
  onSaveDraft?: () => void;
  onPublish?: () => void;
  onRestore?: (snapshot: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const { revisionsFor } = useAdminData();
  const count = revisionsFor(entity, entityId).length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {previewHref ? (
          <Link
            to={previewHref}
            target="_blank"
            className="inline-flex items-center gap-2 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-4 py-2 text-sm font-medium text-foreground-800 hover:bg-background-100"
          >
            <i className="ri-eye-line" aria-hidden="true" />
            Preview
          </Link>
        ) : null}
        <Button variant="outline" icon="ri-history-line" onClick={() => setOpen(true)}>
          History{count ? ` (${count})` : ""}
        </Button>
        {onSaveDraft ? (
          <Button variant="secondary" onClick={onSaveDraft}>
            Save draft
          </Button>
        ) : null}
        {onPublish ? (
          <Button icon="ri-check-line" onClick={onPublish}>
            Publish
          </Button>
        ) : null}
      </div>

      <VersionHistoryModal
        open={open}
        onClose={() => setOpen(false)}
        entity={entity}
        entityId={entityId}
        title={title}
        onRestore={onRestore}
      />
    </>
  );
}