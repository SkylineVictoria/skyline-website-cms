import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRef } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/pages/admin/lib/supabase";
import { countPortalMetric } from "@/pages/agency/lib/devMetrics";
import { passwordRecoveryUrl } from "@/lib/siteUrl";
import type { PortalScope } from "@/lib/portalScope";

export type PortalRole = "slit_admin" | "agency_admin" | "agent";

export interface PortalProfile {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  jobTitle: string;
  status: string;
}

export interface PortalAgency {
  id: string;
  name: string;
  code: string;
  registrationNumber: string;
  businessEmail: string;
  phone: string;
  address: string;
  country: string;
  primaryContact: string;
  status: string;
  isPermanent: boolean;
}

export interface PortalMembership {
  role: "agency_admin" | "agent";
  status: string;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

export interface PortalAuthValue {
  scopes: PortalScope[];
  selectedScope: PortalScope | null;
  scopeEpoch: number;
  selectScope: (key: string) => Promise<void>;
  authUser: { id: string; email: string; name: string } | null;
  role: PortalRole | null;
  profile: PortalProfile | null;
  agency: PortalAgency | null;
  membership: PortalMembership | null;
  authLoading: boolean;
  identityLoading: boolean;
  identityError: string;
  signIn: (email: string, password: string) => Promise<ActionResult>;
  signOut: () => Promise<void>;
  requestReset: (email: string) => Promise<ActionResult>;
  reloadIdentity: () => Promise<void>;
  updateOwnProfile: (patch: Partial<Pick<PortalProfile, "fullName" | "phone" | "jobTitle">>) => Promise<ActionResult>;
  changeOwnPassword: (currentPassword: string, password: string) => Promise<ActionResult>;
}

export const PortalAuthContext = createContext<PortalAuthValue | null>(null);

export function portalPasswordResetUrl(): string {
  return passwordRecoveryUrl();
}

export function usePortalAuth(): PortalAuthValue {
  const ctx = useContext(PortalAuthContext);
  if (!ctx) throw new Error("usePortalAuth must be used within PortalAuthProvider");
  return ctx;
}
