import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { buildSeed } from "@/pages/admin/lib/seed";
import { loadAdminData, persistAdminData, emptyAdminData } from "@/pages/admin/lib/db";
import { useAuth } from "@/pages/admin/lib/authContext";
import type {
  ActivityItem,
  AdminCourse,
  AdminData,
  AdminForm,
  AdminPage,
  AdminSettings,
  DocItem,
  FooterConfig,
  LinkItem,
  NavMenuItem,
  PublishStatus,
  Revision,
  RevisionEntity,
  SeoEntry,
} from "@/pages/admin/lib/types";

export type StoreStatus = "loading" | "error" | "ready";

export interface NewRevision {
  entity: RevisionEntity;
  entityId: string;
  title: string;
  action: string;
  status: PublishStatus;
  snapshot: unknown;
}

export interface StoreContextValue {
  data: AdminData;
  status: StoreStatus;
  error: string | null;
  reload: () => void;
  update: (updater: (draft: AdminData) => AdminData) => void;
  /** Applies an update AND persists it immediately, surfacing any DB error. */
  saveNow: (updater: (draft: AdminData) => AdminData) => Promise<void>;
  logActivity: (action: string, item: string, area: string) => void;
  recordRevision: (rev: NewRevision) => void;
  revisionsFor: (entity: RevisionEntity, entityId: string) => Revision[];
  restoreRevision: (id: string) => void;
  resetToSeed: () => void;
}

export const StoreContext = createContext<StoreContextValue | null>(null);

export function useAdminData() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useAdminData must be used within AdminStoreProvider");
  return ctx;
}
