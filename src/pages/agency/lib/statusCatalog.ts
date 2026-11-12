import { useEffect, useState } from "react";
import { supabase } from "@/pages/admin/lib/supabase";

/** A status as the backend defines it. */
export interface StatusChoice { value: string; label: string; note?: string }
export interface StatusCatalog { application: StatusChoice[]; business: StatusChoice[]; agent: StatusChoice[]; student: StatusChoice[] }

/**
 * Used only until the backend answers (or if it cannot): the same values the database stores. Every list on screen is
 * replaced by the backend's catalogue (portal_status_catalog, migration 111) as soon as it loads.
 */
const FALLBACK: StatusCatalog = {
  // Application statuses come from the database only (application_status_workflow / portal_application_statuses).
  application: [],
  business: [{ value: "Active", label: "Active" }, { value: "Inactive", label: "Inactive" }],
  agent: [{ value: "Active", label: "Active" }, { value: "Invited", label: "Invited" }, { value: "Inactive", label: "Inactive" }],
  student: [{ value: "Active", label: "Active" }, { value: "Inactive", label: "Disabled" }],
};

let cached: StatusCatalog | null = null;
let pending: Promise<StatusCatalog> | null = null;

const choices = (raw: unknown, fallback: StatusChoice[]): StatusChoice[] => {
  if (!Array.isArray(raw)) return fallback;
  const list = raw.map((item) => {
    const r = (item ?? {}) as Record<string, unknown>;
    return { value: String(r.value ?? ""), label: String(r.label ?? r.value ?? ""), note: r.note ? String(r.note) : undefined };
  }).filter((item) => item.value);
  return list.length ? list : fallback;
};

/** Loads the backend catalogue once per page load and shares it. */
export function loadStatusCatalog(): Promise<StatusCatalog> {
  if (cached) return Promise.resolve(cached);
  pending ??= (async () => {
    const { data, error } = await supabase.rpc("portal_status_catalog");
    if (error || !data || typeof data !== "object") return FALLBACK;
    const r = data as Record<string, unknown>;
    cached = {
      application: choices(r.application, FALLBACK.application), business: choices(r.business, FALLBACK.business),
      agent: choices(r.agent, FALLBACK.agent), student: choices(r.student, FALLBACK.student),
    };
    return cached;
  })().catch(() => FALLBACK).finally(() => { pending = null; });
  return pending;
}

/** The status catalogue from the backend (the stored values until it loads). */
export function useStatusCatalog(): StatusCatalog {
  const [catalog, setCatalog] = useState<StatusCatalog>(cached ?? FALLBACK);
  useEffect(() => {
    let active = true;
    void loadStatusCatalog().then((next) => { if (active) setCatalog(next); });
    return () => { active = false; };
  }, []);
  return catalog;
}

/** The label the backend gives a status value (the value itself when unknown). */
export const statusLabel = (list: StatusChoice[], value: string) => list.find((item) => item.value === value)?.label ?? value;
