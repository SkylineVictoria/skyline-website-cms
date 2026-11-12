import { whatsAppDigits } from "@/lib/whatsApp";

/** WhatsApp icon next to a person's name: opens a chat with their number in WhatsApp / WhatsApp Business. Renders nothing without a usable number. */
export default function WhatsAppLink({ phone, name, className = "" }: { phone: string | null | undefined; name?: string; className?: string }) {
  const digits = whatsAppDigits(phone);
  if (!digits) return null;
  const label = `Message ${name || "this person"} on WhatsApp`;
  return (
    <a href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer" aria-label={label} title={label}
      onClick={(e) => e.stopPropagation()}
      className={`ml-1.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full align-middle text-[#25D366] hover:bg-green-50 ${className}`}>
      <i className="ri-whatsapp-line text-lg leading-none" aria-hidden="true" />
    </a>
  );
}
