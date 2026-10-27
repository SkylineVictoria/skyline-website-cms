import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { supabase } from "@/pages/admin/lib/supabase";
import type { AdminUser, Role } from "@/pages/admin/lib/types";
import { passwordRecoveryUrl } from "@/lib/siteUrl";

export const defaultUsers: AdminUser[] = [
  {
    id: "u-1",
    name: "IT Administrator",
    email: "gourav.gupta@siyanainfo.com",
    role: "Admin",
    status: "Active",
    lastLogin: "",
  },
  {
    id: "u-2",
    name: "Marketing Editor",
    email: "gourav.gupta@slit.edu.au",
    role: "Editor",
    status: "Active",
    lastLogin: "",
  },
];

export const passwordResetUrl = passwordRecoveryUrl;

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  mustChangePassword: boolean;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  mustChangePassword?: boolean;
}

export interface AuthContextValue {
  user: SessionUser | null;
  authLoading: boolean;
  users: AdminUser[];
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  can: (area: "governance") => boolean;
  saveUsers: (next: AdminUser[]) => void;
  refreshUsers: () => Promise<void>;
  changePassword: (password: string) => Promise<{ ok: boolean; error?: string }>;
  verifyAndChangePassword: (currentPassword: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  sendPasswordReset: (email: string) => Promise<{ ok: boolean; error?: string }>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
