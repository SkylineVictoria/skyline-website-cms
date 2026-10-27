import { useCallback, useEffect, useState } from "react";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";
import { listAgencyMembers, ROLE_LABELS, type AgencyMemberRow } from "@/pages/agency/lib/portalData";
import { PageHeading, PortalEmpty, PortalError, PortalLoading } from "@/pages/agency/components/PortalUI";

export default function AgencyProfilePage() {
  const { agency, role } = usePortalAuth();
  const [members, setMembers] = useState<AgencyMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const isAgencyAdmin = role === "agency_admin";

  const load = useCallback(async () => {
    if (!agency) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      setMembers(await listAgencyMembers(agency.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "We could not load agency members.");
    } finally {
      setLoading(false);
    }
  }, [agency]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!agency) {
    return (
      <div>
        <PageHeading eyebrow="Agency Profile" title="Agency profile" />
        <div className="mt-6">
          <PortalEmpty icon="ri-building-2-line" title="No agency associated" message="Your account is not linked to an agency." />
        </div>
      </div>
    );
  }

  const details: { label: string; value: string; icon: string }[] = [
    { label: "Agency code", value: agency.code || "\u2014", icon: "ri-hashtag" },
    { label: "Registration / ABN", value: agency.registrationNumber || "\u2014", icon: "ri-file-text-line" },
    { label: "Primary contact", value: agency.primaryContact || "\u2014", icon: "ri-user-line" },
    { label: "Business email", value: agency.businessEmail || "\u2014", icon: "ri-mail-line" },
    { label: "Phone", value: agency.phone || "\u2014", icon: "ri-phone-line" },
    { label: "Country", value: agency.country || "\u2014", icon: "ri-global-line" },
    { label: "Address", value: agency.address || "\u2014", icon: "ri-map-pin-line" },
    { label: "Status", value: agency.status || "\u2014", icon: "ri-checkbox-circle-line" },
  ];

  return (
    <div>
      <PageHeading
        eyebrow="Agency Profile"
        title={agency.name}
        description="Agency information and team members. Agency and role changes are managed by SLIT Administration."
      />

      <section className="mt-6 rounded-card border border-background-200 bg-background-50 p-6">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Agency details</h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {details.map((item) => (
            <div key={item.label} className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background-100 text-base text-foreground-600">
                <i className={item.icon} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <dt className="text-xs font-semibold uppercase tracking-wide text-foreground-500">{item.label}</dt>
                <dd className="mt-0.5 break-words text-sm text-foreground-900">{item.value}</dd>
              </div>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-6">
        <h2 className="font-heading text-base font-semibold text-foreground-950">Team members</h2>
        <div className="mt-3">
          {!isAgencyAdmin ? (
            <PortalEmpty
              icon="ri-lock-2-line"
              title="Member list is restricted"
              message="Only the agency administrator can view the full team list."
            />
          ) : loading ? (
            <PortalLoading label="Loading team members\u2026" />
          ) : error ? (
            <PortalError message={error} onRetry={() => void load()} />
          ) : members.length === 0 ? (
            <PortalEmpty icon="ri-group-line" title="No members yet" message="Agents provisioned for your agency will appear here." />
          ) : (
            <ul className="space-y-3">
              {members.map((member) => (
                <li
                  key={member.profileId}
                  className="flex flex-col gap-2 rounded-lg border border-background-200 bg-background-50 p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-100 text-sm font-semibold text-accent-900">
                      {(member.fullName || member.email || "?").slice(0, 1).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground-950">{member.fullName || "\u2014"}</p>
                      <p className="truncate text-xs text-foreground-500">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 sm:shrink-0">
                    <span className="rounded-full bg-secondary-100 px-2.5 py-1 text-xs font-semibold text-secondary-900">
                      {ROLE_LABELS[member.role]}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        member.status === "Active" ? "bg-accent-100 text-accent-900" : "bg-background-200 text-foreground-600"
                      }`}
                    >
                      {member.status}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}