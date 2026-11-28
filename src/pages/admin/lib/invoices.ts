import { supabase } from "@/pages/admin/lib/supabase";
import type { FeeType } from "@/pages/admin/lib/finance";

/**
 * The Fees module (AXCELERATE-FEES, owner 2026-11-28): a student's invoices with their items and payments (admins). Invoices imported from
 * aXcelerate are read only in Skyline (the import keeps them equal to aXcelerate).
 */
export type InvoiceStatus = "paid" | "part_paid" | "unpaid" | "overdue" | "void";
export interface InvoiceItem { description: string; feeType: FeeType; quantity: number; unitCents: number | null; totalCents: number; gstCents: number }
export interface InvoicePayment { id: string; paidAt: string | null; amountCents: number; refundedCents: number | null; description: string; reference: string | null; source: string }
export interface Invoice {
  id: string; studentId: string; studentName: string; studentNumber: string | null; courseId: string | null; courseCode: string | null; courseTitle: string | null;
  number: string | null; date: string | null; dueDate: string | null; totalCents: number; paidCents: number; creditedCents: number; balanceCents: number;
  source: "axcelerate" | "manual"; description: string | null; status: InvoiceStatus; items: InvoiceItem[]; payments: InvoicePayment[];
}
export interface InvoiceTotals { totalCents: number; paidCents: number; balanceCents: number; overdueCents: number }
export interface InvoiceFilters { q?: string; status?: InvoiceStatus; courseId?: string; from?: string; to?: string; page?: number; pageSize?: number }
export interface InvoicePage { rows: Invoice[]; total: number; page: number; pageSize: number; summary: { totalCents: number; paidCents: number; balanceCents: number; overdue: number; invoices: number } }

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const studentInvoices = (studentId: string) => rpc<{ invoices: Invoice[]; totals: InvoiceTotals }>("student_invoices_list", { p_student: studentId });
export const financeInvoices = (filters: InvoiceFilters) => rpc<InvoicePage>("finance_invoices_list", { p_filters: filters });

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: "success" | "warn" | "primary" | "muted" }> = {
  paid: { label: "Paid", tone: "success" }, part_paid: { label: "Part paid", tone: "warn" }, unpaid: { label: "Unpaid", tone: "warn" },
  overdue: { label: "Overdue", tone: "primary" }, void: { label: "Void", tone: "muted" },
};

/** FEES-MANUAL: create or edit a Skyline invoice (aXcelerate invoices are read only), void it, record a payment against it. */
export interface InvoiceSave {
  id?: string; studentId?: string; courseId?: string | null; number?: string | null; date?: string; dueDate?: string | null; description?: string | null; void?: boolean;
  items?: Array<{ description: string; feeType: FeeType; quantity: number; unitCents: number }>;
}
export const financeInvoiceSave = (data: InvoiceSave) => rpc<string>("finance_invoice_save", { p_data: data });
export const financeInvoicePayment = (invoiceId: string, data: { amountCents: number; paidAt: string; method?: string; reference?: string }) =>
  rpc<string>("finance_invoice_payment", { p_invoice: invoiceId, p_data: data });
