import { Link } from "react-router-dom";
import { PORTAL_VIEWS } from "@/lib/portalPreview";

export default function SwitchView({ selected = "admin", onSelect }: { selected?: string; onSelect?: () => void }) {
  return <div className="border-b border-background-200 px-3 py-2" aria-label="Switch View">
    <p className="mb-1 text-xs font-semibold text-foreground-600">Switch View</p>
    {PORTAL_VIEWS.map(view => <Link key={view.id} to={view.id === "admin" ? "/admin" : `/admin/switch-view/${view.id}`}
      onClick={onSelect} aria-current={view.id === selected ? "page" : undefined}
      className={`flex items-center gap-2 rounded px-2 py-2 text-sm ${view.id === selected ? "bg-primary-500 text-background-50" : "hover:bg-background-100"}`}>
      <i className={view.icon} aria-hidden="true" />{view.label}
      {view.id === selected ? <i className="ri-check-line ml-auto" aria-hidden="true" /> : null}
    </Link>)}
  </div>;
}
