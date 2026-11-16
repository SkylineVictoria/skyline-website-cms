import { Badge } from "../ui";
import { formatMoney, paymentStatus, type SigningPayment } from "@/lib/signingApi";

/** The Stripe payment of a request at a glance: Pending / Checkout open / Processing / Paid / Failed / Refunded, the amount, and "Test" for a test-mode payment. */
export default function PaymentBadge({ payment }: { payment: SigningPayment }) {
  const status = paymentStatus(payment.status);
  return <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="payment-badge" data-status={payment.status}>
    <Badge tone={status.tone}>{status.label}</Badge>
    <span className="text-xs text-foreground-700">{formatMoney(payment.status === "paid" && payment.amount_paid_cents != null ? payment.amount_paid_cents : payment.amount_cents, payment.currency)}</span>
    {payment.livemode === false && <span className="rounded border border-amber-300 bg-amber-50 px-1.5 text-2xs font-semibold uppercase text-amber-900" title="Made with Stripe test keys: no real money moves">Test</span>}
  </span>;
}
