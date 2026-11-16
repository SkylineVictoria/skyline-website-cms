import ResponsiveTable from "@/components/ui/ResponsiveTable";
import { Link } from "react-router-dom";
import { ApplicationStatusBadge, CompletionBar } from "@/pages/admin/components/AgencyStatus";
import type { ApplicationRow } from "@/pages/admin/lib/businessData";
import { formatDate } from "@/pages/agency/lib/portalData";

/** A student's or agent's applications. Fits the page width; on narrow screens each row becomes a card. */
export default function ApplicationsList({ rows, showAgent = false }: { rows: ApplicationRow[]; showAgent?: boolean }) {
  return (
    <ResponsiveTable>
      <thead>
        <tr>
          <th className="w-[15%]">Reference</th>
          <th className={showAgent ? "w-[27%]" : "w-[37%]"}>Course</th>
          <th className="w-[12%]">Intake</th>
          {showAgent ? <th className="w-[14%]">Agent</th> : null}
          <th className="w-[12%]">Progress</th>
          <th className="w-[11%]">Status</th>
          <th className="w-[11%]">Updated</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((a) => (
          <tr key={a.id}>
            <td className="tabular-nums"><Link to={`/admin/applications/${a.id}`} className="font-medium text-primary-700 hover:underline">{a.reference || "Draft"}</Link></td>
            <td>{a.courses.length ? a.courses.map((c) => <p key={c.code}><b className="text-foreground-900">{c.code}</b> {c.title}{c.discountPercent ? <span className="ml-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-2xs font-semibold text-emerald-800" data-testid="course-discount">{c.discountPercent}% discount</span> : null}</p>) : <span className="text-xs text-foreground-500">No course yet</span>}</td>
            <td>{a.intake || <span className="text-xs text-foreground-500">Not set</span>}</td>
            {showAgent ? <td>{a.agentId ? <Link to={`/admin/agents/${a.agentId}`} className="hover:text-primary-700">{a.agentName}</Link> : <span className="text-xs text-foreground-500">Not assigned</span>}</td> : null}
            <td><CompletionBar value={a.completion} /></td>
            <td><ApplicationStatusBadge status={a.status} /></td>
            <td className="text-xs text-foreground-600">{formatDate(a.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </ResponsiveTable>
  );
}
