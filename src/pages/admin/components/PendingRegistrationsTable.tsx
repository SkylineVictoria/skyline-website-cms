import ResponsiveTable from "@/components/ui/ResponsiveTable";
import WhatsAppLink from "@/components/base/WhatsAppLink";
import { Link } from "react-router-dom";
import { Button } from "@/pages/admin/components/ui";
import { ListMessage } from "@/pages/admin/components/ListControls";
import type { PendingRegistration } from "@/pages/admin/lib/businessData";
import { formatDate } from "@/pages/agency/lib/portalData";

/** Businesses that registered themselves from the sign-in page and wait for a SLIT decision. */
export default function PendingRegistrationsTable({ rows, loading, busyId, onApprove, onDecline }: {
  rows: PendingRegistration[]; loading: boolean; busyId: string; onApprove: (row: PendingRegistration) => void; onDecline: (row: PendingRegistration) => void;
}) {
  if (!loading && rows.length === 0) {
    return <ListMessage icon="ri-user-add-line" title="No registrations waiting" text="When an agent registers their business from the sign-in page, it appears here for approval." />;
  }
  return (
    <div className={loading ? "opacity-60 transition-opacity" : ""}>
      <ResponsiveTable aria-busy={loading}>
        <thead>
          <tr>
            <th className="w-[30%]">Business</th>
            <th className="w-[26%]">Contact</th>
            <th className="w-[14%]">Requested</th>
            <th className="w-[14%]">Sign-in</th>
            <th className="w-[16%]"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const login = row.signedIn ? "Password set" : row.invitation?.status === "expired" ? "Invite expired" : row.invitation ? "Invited" : "No invitation";
            return (
              <tr key={row.id}>
                <td>
                  <Link to={`/admin/businesses/${row.id}`} className="font-semibold text-foreground-900 hover:text-primary-700">{row.name}</Link>
                  <p className="mt-0.5 text-xs text-foreground-500">{row.abn ? `ABN ${row.abn}` : "No ABN"}</p>
                </td>
                <td className="text-xs">
                  <p className="font-medium text-foreground-900">{row.contact || "—"}<WhatsAppLink phone={row.phone} name={row.contact || row.name} /></p>
                  {row.email ? <p><a href={`mailto:${row.email}`} className="text-foreground-700 hover:text-primary-700">{row.email}</a></p> : null}
                  {row.phone ? <p className="text-foreground-600">{row.phone}</p> : null}
                </td>
                <td className="text-xs text-foreground-700">{row.requestedAt ? formatDate(row.requestedAt) : "—"}</td>
                <td>
                  <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${row.signedIn ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>{login}</span>
                </td>
                <td>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" disabled={busyId === row.id} onClick={() => onApprove(row)}>{busyId === row.id ? "Saving…" : "Approve"}</Button>
                    <Button size="sm" variant="ghost" disabled={busyId === row.id} onClick={() => onDecline(row)}>Decline</Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </ResponsiveTable>
    </div>
  );
}
