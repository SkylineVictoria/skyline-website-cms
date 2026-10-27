import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fallbackSiteData, loadPublicSiteData, type PublicSiteData } from "@/lib/publicData";

export type PublicSiteStatus = "loading" | "ready" | "error";

export type PublicSiteSource = "fallback" | "database";

export interface PublicSiteContextValue {
  data: PublicSiteData;
  status: PublicSiteStatus;
  /** True only when the current data is backed by real Supabase records. */
  isLive: boolean;
  error: string | null;
  /** Silent background refresh — keeps current content visible while updating. */
  refresh: () => Promise<void>;
  /** Full reload that surfaces the loading state again. */
  reload: () => void;
}

export const PublicSiteContext = createContext<PublicSiteContextValue | null>(null);

export function usePublicSite(): PublicSiteContextValue {
  const context = useContext(PublicSiteContext);
  if (!context) {
    throw new Error("usePublicSite must be used within a PublicSiteProvider");
  }
  return context;
}
