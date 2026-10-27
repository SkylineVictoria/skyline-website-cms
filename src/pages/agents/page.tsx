import AgentsTable from "@/components/feature/AgentsTable";
import HtmlContent from "@/components/feature/HtmlContent";
import PageHero from "@/components/feature/PageHero";
import Seo from "@/components/feature/Seo";
import { breadcrumbSchema } from "@/data/seo";
import { usePublicSite } from "@/hooks/publicSiteContext";

export default function AgentsPage() {
  const { data, isLive } = usePublicSite();
  // The Registered Agents table is authored in CMS → Pages → Registered Agents.
  // Once Supabase is authoritative we render the saved table (so admin edits
  // appear immediately); otherwise we show the interactive static table.
  const body = data.pages.agents?.body ?? "";

  return (
    <>
      <Seo
        title="Registered Agents | Skyline Institute Of Technology"
        description="Find a registered education agent of Skyline Institute Of Technology across Melbourne, Sydney, Brisbane, Perth, Adelaide and Canberra."
        path="/agents"
        jsonLd={[
          breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Registered Agents", path: "/agents" },
          ]),
        ]}
      />
      <PageHero title="Registered Agents" breadcrumb="Agents" />
      <section className="bg-background-50 py-12 md:py-16">
        <div className="site-container">
          {isLive && body.trim() ? <HtmlContent html={body} /> : <AgentsTable />}
        </div>
      </section>
    </>
  );
}