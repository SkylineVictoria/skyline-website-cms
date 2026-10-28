import NotificationGateBanner from "@/pages/admin/components/NotificationGateBanner";
import NotificationLogTable from "@/pages/admin/components/NotificationLogTable";
import { PageHeader } from "@/pages/admin/components/ui";

/** Notification log (administrators only): who each notification email went to, and whether it was sent. */
export default function NotificationLogPage() {
  return (
    <div>
      <PageHeader breadcrumb="Website Settings > Notification log" title="Notification log" description="Every notification email the system prepared, one row per recipient. Blocked means it was recorded but not sent." />
      <NotificationGateBanner />
      <NotificationLogTable />
    </div>
  );
}
