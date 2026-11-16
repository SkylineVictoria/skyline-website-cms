// Opens the floating communication popup (admin area) from anywhere: a person's Message button, the Communication Hub, etc.
export type CommPopupTarget = { conversationId?: string; teamId?: string; tab?: "conversations" | "people" | "teams" };
export const COMM_POPUP_EVENT = "skyline:comm-popup";
export function openCommPopup(target: CommPopupTarget = {}): void {
  window.dispatchEvent(new CustomEvent<CommPopupTarget>(COMM_POPUP_EVENT, { detail: target }));
}
