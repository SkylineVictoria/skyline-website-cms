import { useParams } from "react-router-dom";
import TicketList from "@/components/support/TicketList";
import TicketView from "@/components/support/TicketView";
import { PageHeader } from "@/pages/admin/components/ui";

/** CMS > Tickets: every support ticket raised by students and agents. */
export default function TicketsPage() {
  return (
    <div>
      <PageHeader title="Tickets" description="Support tickets raised by students and agents. Assign one to yourself, reply, add internal notes and set the status." />
      <TicketList handler linkTo={(id) => `/admin/tickets/${id}`} />
    </div>
  );
}

export function TicketDetailPage() {
  const { id = "" } = useParams();
  return <TicketView id={id} backTo="/admin/tickets" />;
}
