import { createPortal } from "react-dom";

/** The message from useToast, bottom centre above the form's footer and above a wizard dialog. */
export default function Toast({ message, onDismiss }: { message: { id: number; text: string } | null; onDismiss: () => void }) {
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-16 z-[120] flex justify-center px-4" role="status" aria-live="polite">
      {message ? (
        <div key={message.id} className="toast-in pointer-events-auto flex max-w-full items-center gap-2 rounded-lg bg-foreground-950 px-3.5 py-2.5 text-sm text-background-50 shadow-lg">
          <i className="ri-sparkling-2-line text-base leading-none text-primary-300" aria-hidden="true" />
          <span>{message.text}</span>
          <button type="button" onClick={onDismiss} aria-label="Dismiss" className="ml-1 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-background-300 hover:text-background-50">
            <i className="ri-close-line text-base leading-none" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
