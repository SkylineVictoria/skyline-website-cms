// Timetable settings (LMS › Timetable › Settings): the rarely changed lists in one place, as tabs
// (?tab=): term breaks, locations and rooms, and the saved course timetables.
import { useSearchParams } from "react-router-dom";
import LmsTermBreaksPage from "../LmsTermBreaksPage";
import LmsLocationsPage from "../LmsLocationsPage";
import LmsTimetableTemplatesPage from "../LmsTimetableTemplatesPage";

const TABS = [
  { id: "breaks", label: "Term breaks" },
  { id: "locations", label: "Locations & rooms" },
  { id: "templates", label: "Saved course timetables" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export default function TimetableSettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "breaks") as TabId;
  return (
    <div>
      <div role="tablist" aria-label="Timetable settings" className="mb-4 flex flex-wrap gap-1 border-b border-background-200">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setParams(t.id === "breaks" ? {} : { tab: t.id }, { replace: true })}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === t.id ? "border-primary-500 text-primary-700" : "border-transparent text-foreground-600 hover:text-foreground-900"}`}>{t.label}</button>
        ))}
      </div>
      {tab === "breaks" ? <LmsTermBreaksPage /> : tab === "locations" ? <LmsLocationsPage /> : <LmsTimetableTemplatesPage />}
    </div>
  );
}
