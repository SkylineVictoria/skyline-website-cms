import { useEffect, useState } from "react";
import { Button, Field, Modal, Select } from "@/pages/admin/components/ui";
import { agentDeletePreview, deleteAgent, type AgentDeletePreview } from "@/pages/admin/lib/businessData";

/**
 * Delete agent (owner 2026-11-24): SLIT administrators remove an agent from their business. The business's point of contact cannot be
 * deleted here (delete the business instead). An agent with students hands them to another agent of the same business first; their
 * applications, documents and history stay. The agent's sign-in to the business ends at once. The database checks the same rules.
 */
export default function DeleteAgentDialog({ agent, onClose, onDeleted }: {
  agent: { agentId: string; name: string; businessName: string };
  onClose: () => void;
  onDeleted: (message: string) => void | Promise<void>;
}) {
  const [preview, setPreview] = useState<AgentDeletePreview | null>(null);
  const [moveTo, setMoveTo] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    agentDeletePreview(agent.agentId)
      .then((p) => { if (live) { setPreview(p); if (p.moveTo.length === 1) setMoveTo(p.moveTo[0].id); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : "We could not check this agent."); });
    return () => { live = false; };
  }, [agent.agentId]);

  const needsMove = (preview?.students ?? 0) > 0;
  const blocked = !preview || preview.pointOfContact || (needsMove && (preview.moveTo.length === 0 || !moveTo));
  const remove = async () => {
    if (working || blocked) return;
    setWorking(true); setError("");
    try {
      const r = await deleteAgent(agent.agentId, needsMove ? moveTo : null);
      await onDeleted(r.studentsMoved
        ? `${r.name} was deleted. ${r.studentsMoved} student${r.studentsMoved === 1 ? "" : "s"} moved to ${r.movedTo}.`
        : `${r.name} was deleted.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not delete this agent.");
      setWorking(false);
    }
  };

  return <Modal open title={`Delete ${agent.name}?`} onClose={() => { if (!working) onClose(); }} width="max-w-xl"
    footer={<div className="flex justify-end gap-2">
      <Button variant="outline" disabled={working} onClick={onClose}>Cancel</Button>
      <Button variant="danger" icon="ri-delete-bin-line" disabled={working || blocked} onClick={() => void remove()} data-testid="delete-agent-confirm">
        {working ? "Deleting…" : "Delete agent"}
      </Button>
    </div>}>
    <div className="space-y-3 text-sm" data-testid="delete-agent-dialog">
      {!preview && !error ? <p className="text-foreground-600">Checking this agent&hellip;</p> : null}
      {preview?.pointOfContact ? (
        <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
          {agent.name} is the point of contact of {agent.businessName}, so they can&apos;t be deleted on their own. Delete the business instead, or make someone else its point of contact first.
        </p>
      ) : preview ? <>
        <p className="text-foreground-700">
          {agent.name} is removed from {agent.businessName} and can no longer sign in to it. Any invitation still waiting is withdrawn.
          Their students&apos; applications, documents and history are kept. This can&apos;t be undone; add them again later if needed.
        </p>
        {needsMove ? (preview.moveTo.length ? (
          <Field label={`Move their ${preview.students} student${preview.students === 1 ? "" : "s"} to`} required>
            <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} data-testid="delete-agent-move-to">
              <option value="">Choose an agent of {agent.businessName}</option>
              {preview.moveTo.map((a) => <option key={a.id} value={a.id}>{a.name}{a.role === "agency_admin" ? " (business admin)" : ""}{a.status !== "Active" ? ` · ${a.status}` : ""}</option>)}
            </Select>
          </Field>
        ) : (
          <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-amber-900">
            {agent.name} has {preview.students} student{preview.students === 1 ? "" : "s"} and {agent.businessName} has no other agent to take them over. Add another agent to the business first.
          </p>
        )) : <p className="text-foreground-600">They have no students.</p>}
      </> : null}
      {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-red-700">{error}</p> : null}
    </div>
  </Modal>;
}
