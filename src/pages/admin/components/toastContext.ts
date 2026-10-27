import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
} from "react";
import { supabase } from "@/pages/admin/lib/supabase";

export interface Toast {
  id: number;
  message: string;
  tone: "success" | "error" | "info";
}

export const ToastContext = createContext<{ push: (message: string, tone?: Toast["tone"]) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
