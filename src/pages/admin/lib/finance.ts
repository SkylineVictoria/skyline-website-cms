import { supabase } from "@/pages/admin/lib/supabase";

/**
 * Finance › Payments: public.payments joined to the signing request, the offer letter, the application, its first course and the
 * agency (finance_payments_list, staff only, filtered / sorted / paged on the server; finance_payments_options for the filter lists).
 */
export interface FinancePaymentRow {
  id: string; created_at: string; paid_at: string | null; paid_or_created: string; status: string; amount_cents: number; amount_paid_cents: number | null; amount_refunded_cents: number | null;
  currency: string; description: string; livemode: boolean | null; stripe_payment_intent_id: string | null; stripe_checkout_session_id: string | null; stripe_charge_id: string | null;
  receipt_url: string | null; payer_email: string | null; failure_reason: string | null; subject_type: string; subject_id: string; request_reference: string | null; request_title: string | null;
  request_state: string | null; application_id: string | null; application_reference: string | null; application_status: string | null; student_name: string; student_email: string;
  course_id: string | null; course_code: string | null; course_title: string | null; agency_id: string | null; agency_name: string | null; offer_letter_id: string | null;
  offer_accepted_at: string | null; deposit_paid_at: string | null; tenant_id: string | null;
  /** OFFER-DEPOSIT: reminders sent for a pending deposit and the letter's automatic-reminder switch. */
  reminder_count?: number | null; last_reminder_at?: string | null; deposit_auto_remind?: boolean | null;
  /** AVETMISS-UI (finance_payments_list_v2): the payment's own fee type, source, student and reference. */
  fee_type?: FeeType | null; source?: PaymentSource; student_id?: string | null; intake_enrolment_id?: string | null; external_reference?: string | null;
  refunded_at?: string | null; student_number?: string | null;
}
export type FeeType = "tuition" | "enrolment" | "materials" | "oshc" | "other";
export type PaymentSource = "stripe" | "xero" | "manual" | "axcelerate";
export const FEE_TYPES: Array<{ value: FeeType; label: string }> = [
  { value: "tuition", label: "Tuition" }, { value: "enrolment", label: "Enrolment" }, { value: "materials", label: "Materials" }, { value: "oshc", label: "OSHC" }, { value: "other", label: "Other" },
];
export const PAYMENT_SOURCES: Array<{ value: PaymentSource; label: string }> = [{ value: "stripe", label: "Stripe" }, { value: "xero", label: "Xero" }, { value: "manual", label: "Manual" }, { value: "axcelerate", label: "aXcelerate" }];
export const feeTypeLabel = (v?: string | null) => FEE_TYPES.find((f) => f.value === v)?.label ?? "";
export const sourceLabel = (v?: string | null) => PAYMENT_SOURCES.find((f) => f.value === v)?.label ?? (v ?? "");
export interface FinanceSummary { collectedCents: number; refundedCents: number; paid: number; pending: number; failed: number; refunded: number; total: number }
export interface FinanceFilters { from?: string; to?: string; status?: string; courseId?: string; agencyId?: string; q?: string; feeType?: FeeType | "none"; source?: PaymentSource; sort?: "date" | "amount" | "student" | "status"; dir?: "asc" | "desc"; page?: number; pageSize?: number }
export interface FinancePage { rows: FinancePaymentRow[]; total: number; page: number; pageSize: number; summary: FinanceSummary }
export interface FinanceOptions { courses: { id: string; code: string; title: string }[]; agencies: { id: string; name: string }[]; statuses: string[] }

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const financePayments = (filters: FinanceFilters) => rpc<FinancePage>("finance_payments_list_v2", { p_filters: filters });
export interface PaymentStudent { id: string; name: string; email: string | null; studentNumber: string | null }
export const financePaymentStudents = () => rpc<PaymentStudent[]>("finance_payment_students");
/** Add a manual payment (no id: source manual, status paid) or edit one (only the keys sent change; refunds only for manual payments). */
export interface PaymentSave {
  id?: string; feeType?: FeeType | null; studentId?: string | null; courseId?: string | null; externalReference?: string | null; description?: string;
  amountCents?: number; paidAt?: string; refundCents?: number; refundedAt?: string | null;
}
export const financePaymentSave = (data: PaymentSave) => rpc<string>("finance_payment_save", { p_data: data });
export const financeOptions = () => rpc<FinanceOptions>("finance_payments_options");

/** Pending / Paid / Failed / Refunded as the page groups Stripe's states. */
export const financeStatus = (status: string): { label: string; tone: "paid" | "pending" | "failed" | "refunded" } =>
  status === "paid" ? { label: "Paid", tone: "paid" } : status === "failed" ? { label: "Failed", tone: "failed" } : status === "refunded" ? { label: "Refunded", tone: "refunded" }
    : { label: status === "processing" ? "Processing" : status === "open" ? "Checkout open" : "Pending", tone: "pending" };
/** The payment in the Stripe dashboard, in test mode when the payment was made with test keys. */
export const stripeDashboardUrl = (row: Pick<FinancePaymentRow, "stripe_payment_intent_id" | "livemode">) =>
  row.stripe_payment_intent_id ? `https://dashboard.stripe.com/${row.livemode === false ? "test/" : ""}payments/${encodeURIComponent(row.stripe_payment_intent_id)}` : null;
