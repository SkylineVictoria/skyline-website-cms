import { Link, Navigate, useParams } from "react-router-dom";
import { useAuth } from "@/pages/admin/lib/authContext";
import { previewView, PORTAL_VIEWS } from "@/lib/portalPreview";
import SwitchView from "./components/SwitchView";

export default function PortalPreviewPage() {
  const { user, authLoading } = useAuth();
  const { view } = useParams();
  const selected = previewView(view);
  if (authLoading) return <p role="status">Checking administrator access…</p>;
  if (!user || user.role !== "Admin" || user.mustChangePassword || !selected) return <Navigate to="/admin" replace />;
  return <div className="flex h-dvh flex-col bg-background-100">
    <header className="z-50 flex shrink-0 flex-wrap items-center gap-3 border-b border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <div className="min-w-0 flex-1"><strong>{PORTAL_VIEWS.find(v => v.id === selected)?.label} · Read-only preview</strong>
        <p className="text-xs">Sample identity and empty sample records. No actual student, agent or staff records are loaded.</p>
      </div>
      <details key={selected} className="relative"><summary className="cursor-pointer rounded border px-3 py-2">Switch View</summary>
        <div className="absolute right-0 top-full mt-2 max-h-[65dvh] w-60 max-w-[calc(100vw-2rem)] overflow-y-auto rounded border bg-background-50 shadow-lg"><SwitchView selected={selected} /></div>
      </details>
      <Link to="/admin" className="rounded bg-primary-600 px-3 py-2 font-semibold text-white">Return to Admin</Link>
    </header>
    <iframe key={selected} title={`${selected} portal preview`} src={`/portal-preview/${selected}`} className="min-h-0 w-full flex-1 border-0" />
  </div>;
}
