import { supabase } from "@/pages/admin/lib/supabase";
import type { DiscoveredAgent, OmaraAgent } from "../../supabase/functions/_shared/omara";

// OMARA migration agent discovery (2026-11-24): the omara-discovery Edge Function (administrators) and the link RPCs.
// Registered migration agents found here are never SLIT education agents; their contact details are for verification and onboarding only.

export type { DiscoveredAgent, OmaraAgent };
export interface OmaraFacts { abn?: string; agencyId?: string; names: string[]; website?: string | null; postcode?: string | null; state?: string | null; places?: string[]; people?: string[] }
export interface OmaraStatus { enabled: boolean; configured: boolean; provider: "brave" | "tavily"; threshold: number; maxPages: number }
export interface OmaraRun { id: string | null; queries?: string[]; results?: number; pagesFetched: number; searches?: number; estCostUsd?: number; errors: string[] }
export interface DiscoverAnswer { enabled: boolean; configured: boolean; provider: string; threshold?: number; agents: DiscoveredAgent[]; run?: OmaraRun; message?: string }
export interface ImportAnswer { agents: DiscoveredAgent[]; rejected: string[]; skipped: number; run: OmaraRun }
/** A linked agent (omara_agents_for_agency). */
export type LinkedAgent = Omit<OmaraAgent, "otherBusinesses" | "rawFields"> & { confidence: number; evidence: string[]; linkedAt: string; linkedBy: string | null };
/** {MARN: {confidence, evidence}} saved with the link. */
export type LinkEvidence = Record<string, { confidence: number; evidence: string[] }>;

async function call<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.functions.invoke("omara-discovery", { body });
  if (error) {
    let message = fallback;
    try { const r = await error.context?.json(); if (typeof r?.message === "string") message = r.message; } catch { /* fallback */ }
    throw new Error(message);
  }
  return data as T;
}

export const omaraStatus = () => call<OmaraStatus>({ action: "status" }, "Agent discovery is not available.");
export const omaraDiscover = (facts: OmaraFacts) => call<DiscoverAnswer>({ action: "discover", ...facts }, "The search for registered migration agents failed.");
export const omaraImportUrls = (urls: string[], facts: OmaraFacts) => call<ImportAnswer>({ action: "import_urls", urls, ...facts }, "The OMARA links could not be read.");
export const omaraRefresh = (marn: string, agencyId?: string) =>
  call<{ agent: DiscoveredAgent; outcome: string | null; changed: Record<string, unknown> }>({ action: "refresh", marn, agencyId }, "The official record could not be read.");
export const omaraCheckConnection = (connector: "brave_search" | "tavily") =>
  call<{ ok: boolean; configured: boolean; results?: number; code?: string; message?: string }>({ action: "check", connector }, "The check could not run.");

export async function omaraLinked(agencyId: string): Promise<LinkedAgent[]> {
  const { data, error } = await supabase.rpc("omara_agents_for_agency", { p_agency: agencyId });
  if (error) throw new Error(error.message);
  return (data ?? []) as LinkedAgent[];
}
export async function omaraLink(agencyId: string, marns: string[], evidence: LinkEvidence): Promise<number> {
  const { data, error } = await supabase.rpc("omara_link_agents", { p_agency: agencyId, p_marns: marns, p_evidence: evidence });
  if (error) throw new Error(error.message);
  return Number((data as { linked?: number } | null)?.linked ?? 0);
}
export async function omaraUnlink(agencyId: string, marn: string): Promise<void> {
  const { error } = await supabase.rpc("omara_unlink_agent", { p_agency: agencyId, p_marn: marn });
  if (error) throw new Error(error.message);
}

/** Verified (read now) or stored (read recently) records; search-only hits have no MARN and cannot be linked. */
export const isRecord = (a: DiscoveredAgent): a is Extract<DiscoveredAgent, { marn: string }> => a.verification !== "search_only";
export const evidenceOf = (agents: DiscoveredAgent[], marns: string[]): LinkEvidence =>
  Object.fromEntries(agents.filter(isRecord).filter((a) => marns.includes(a.marn)).map((a) => [a.marn, { confidence: a.confidence, evidence: a.evidence }]));
/** Pasted text -> the links in it (one per line, or separated by spaces / commas). */
export const splitLinks = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s)))];
