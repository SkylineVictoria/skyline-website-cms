import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import NewTicketForm from "@/components/support/NewTicketForm";
import TicketList from "@/components/support/TicketList";
import TicketView from "@/components/support/TicketView";
import { PageHeading } from "@/pages/agency/components/PortalUI";
import { usePortalAuth } from "@/pages/agency/lib/portalAuthContext";

/** Agency / Student Portal > Support tickets: raise a ticket and follow the replies. */
export default function PortalTicketsPage() {
  const { role } = usePortalAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const isStudent = role === "student";
  return (
    <div className="space-y-5">
      <PageHeading title="Support tickets" description={isStudent ? "Ask Skyline about your enrolment, documents, fees or course." : "Ask Skyline about enrolments, documents, fees or courses for you or your students."}
        action={creating ? undefined : (
          <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-2 rounded-md bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700">
            <i className="ri-add-line" aria-hidden="true" />New ticket
          </button>
        )} />
      {creating ? <NewTicketForm isStudent={isStudent} onCancel={() => setCreating(false)} onCreated={(id) => navigate(`/agency/tickets/${id}`)} /> : null}
      <TicketList linkTo={(id) => `/agency/tickets/${id}`} />
    </div>
  );
}

export function PortalTicketDetailPage() {
  const { id = "" } = useParams();
  return <TicketView id={id} backTo="/agency/tickets" />;
}
