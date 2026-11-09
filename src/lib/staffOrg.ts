import type { StaffRole, StaffStatus } from "@/lib/staffStatus";

/** Staff org chart: who reports to whom (hr_admin_org_chart), built into a tree in the browser. Pure functions only. */

/** One row of hr_admin_org_chart: the person and their hr.employment details. */
export interface OrgPerson {
  id: string; name: string; email: string; status: StaffStatus; role: StaffRole | null;
  jobTitle: string; department: string; employmentType: "full_time" | "part_time" | null; workLocation: string; managerId: string | null;
}
export interface OrgNode { person: OrgPerson; children: OrgNode[]; /** Everyone below, at any depth. */ teamSize: number }

const label = (p: OrgPerson) => (p.name || p.email).toLowerCase();

/**
 * Builds the tree. People whose manager is missing from the list are shown at the top; so is anyone caught in a loop
 * (the database refuses loops, so this only guards against stale data). Children are sorted by name.
 */
export function buildOrgTree(people: OrgPerson[]): OrgNode[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const kids = new Map<string, OrgPerson[]>();
  const roots: OrgPerson[] = [];
  for (const p of people) {
    const m = p.managerId && p.managerId !== p.id && byId.has(p.managerId) ? p.managerId : null;
    if (m) kids.set(m, [...(kids.get(m) ?? []), p]); else roots.push(p);
  }
  const placed = new Set<string>();
  const build = (p: OrgPerson): OrgNode => {
    placed.add(p.id);
    const children = (kids.get(p.id) ?? []).filter((c) => !placed.has(c.id)).sort((a, b) => label(a).localeCompare(label(b))).map(build);
    return { person: p, children, teamSize: children.reduce((n, c) => n + 1 + c.teamSize, 0) };
  };
  const tree = roots.sort((a, b) => label(a).localeCompare(label(b))).map(build);
  // Anyone not reached is in a loop: show them at the top so nobody disappears.
  for (const p of people) if (!placed.has(p.id)) tree.push(build(p));
  return tree;
}

/** The person and everyone below them: none of these can become their manager. */
export function teamOf(people: OrgPerson[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of people) if (p.managerId && out.has(p.managerId) && !out.has(p.id)) { out.add(p.id); grew = true; }
  }
  return out;
}

/** Why `managerId` cannot be the manager of `id`, or null when it can (null manager: top of the chart). */
export function placeProblem(people: OrgPerson[], id: string, managerId: string | null): string | null {
  if (!managerId) return null;
  if (managerId === id) return "A person cannot be their own manager.";
  const manager = people.find((p) => p.id === managerId);
  if (!manager) return "Choose a manager from the org chart.";
  if (manager.status !== "active") return "Choose an active employee as the manager.";
  if (teamOf(people, id).has(managerId)) return "That person already reports to them. Move them first, or choose someone else.";
  return null;
}

/** The chain from the top of the chart down to the person (for "Reports to: A > B"). */
export function managerChain(people: OrgPerson[], id: string): OrgPerson[] {
  const byId = new Map(people.map((p) => [p.id, p]));
  const chain: OrgPerson[] = [];
  const seen = new Set<string>([id]);
  let next = byId.get(id)?.managerId ?? null;
  while (next && !seen.has(next) && byId.has(next)) { seen.add(next); chain.unshift(byId.get(next)!); next = byId.get(next)!.managerId; }
  return chain;
}

/** Ids of every node with children: "Expand all". */
export function nodesWithTeams(tree: OrgNode[]): string[] {
  const out: string[] = [];
  const walk = (n: OrgNode) => { if (n.children.length) out.push(n.person.id); n.children.forEach(walk); };
  tree.forEach(walk);
  return out;
}

/** Whether the node or anyone below it matches the search (name, email, job title or department). */
export function orgMatches(node: OrgNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const p = node.person;
  return [p.name, p.email, p.jobTitle, p.department].some((v) => v.toLowerCase().includes(q)) || node.children.some((c) => orgMatches(c, q));
}
