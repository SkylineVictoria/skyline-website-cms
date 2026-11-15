import { useState } from "react";
import { Link } from "react-router-dom";

const sections = [
  { id: "accounts", label: "Email Accounts", icon: "ri-mail-line", detail: "Microsoft 365 mailbox inventory and account status will appear here once connected." },
  { id: "create", label: "Create Email", icon: "ri-user-add-line", detail: "Select an existing student, employee or trainer to provision a mailbox. Provisioning is not yet configured." },
  { id: "automation", label: "Automation Rules", icon: "ri-git-branch-line", detail: "Onboarding and offboarding automation will be configured here. No rules are enabled." },
  { id: "settings", label: "Microsoft 365 Settings", icon: "ri-settings-3-line", detail: "Microsoft Entra tenant, verified domain, admin consent and licensing must be configured securely before provisioning." },
  { id: "audit", label: "Audit Logs", icon: "ri-history-line", detail: "Account provisioning and administration activity will be logged here after backend integration." },
] as const;
type Section = typeof sections[number]["id"];
export default function EmailManagementPage() {
  const [active, setActive] = useState<Section>("accounts");
  const current = sections.find(section => section.id === active)!;
  return <main className="mx-auto max-w-6xl space-y-6 pb-12">
    <header>
      <p className="text-xs font-semibold uppercase tracking-wide text-foreground-500">Administration / Shared services</p>
      <h1 className="mt-1 font-heading text-3xl font-bold text-foreground-950">Email Management</h1>
      <p className="mt-2 text-sm text-foreground-600">Manage SLIT Microsoft 365 email accounts without duplicating CRM or HRMS records.</p>
    </header>
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="status">
      <strong>Setup required.</strong> Microsoft 365 is not connected to this module yet. No accounts can be created, modified or disabled from this screen.
    </div>
    <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
      <nav className="space-y-1" aria-label="Email Management sections">
        {sections.map(section => <button key={section.id} type="button" onClick={() => setActive(section.id)}
          aria-current={active === section.id ? "page" : undefined}
          className={`flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left text-sm font-medium ${active === section.id ? "bg-primary-500 text-white" : "border border-background-200 text-foreground-800 hover:bg-background-100"}`}>
          <i className={section.icon} aria-hidden="true" />{section.label}
        </button>)}
      </nav>
      <section className="min-h-64 rounded-xl border border-background-200 bg-white p-6">
        <h2 className="text-xl font-semibold text-foreground-950">{current.label}</h2>
        <p className="mt-3 text-sm text-foreground-600">{current.detail}</p>
        {active === "create" && <div className="mt-6 rounded-lg border border-background-200 p-4 text-sm">
          Choose an existing person from <Link className="text-primary-600 underline" to="/admin/students">Students</Link> or <Link className="text-primary-600 underline" to="/admin/staff/employees">Employees</Link> after the Microsoft 365 connection is configured.
        </div>}
        {active === "settings" && <p className="mt-5 text-sm text-foreground-600">Never enter a client secret in the browser. Credentials must be configured in secure server-side settings.</p>}
      </section>
    </div>
  </main>;
}
