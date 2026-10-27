import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useBlocker } from "react-router-dom";
import { DraftRegistryContext, type DraftRegistry } from "@/pages/admin/lib/draftContext";

const LEAVE_MESSAGE = "You have unsaved changes. They stay on this device as a draft you can restore, but they are not saved to the website. Leave this page?";

/** Placed once at the admin layout: tracks dirty editors and warns before in-app navigation (router blocker) and before the tab is closed or reloaded. */
export function DraftProvider({ children }: { children: ReactNode }) {
  const dirty = useRef(new Set<string>());
  const registry = useMemo<DraftRegistry>(() => ({
    setDirty: (key, value) => { if (value) dirty.current.add(key); else dirty.current.delete(key); },
    clear: (key) => { dirty.current.delete(key); },
    anyDirty: () => dirty.current.size > 0,
  }), []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty.current.size) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  // Router-level guard: covers link clicks, the browser Back/Forward buttons and programmatic navigate() calls.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty.current.size > 0 && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm(LEAVE_MESSAGE)) blocker.proceed(); else blocker.reset();
  }, [blocker]);

  return <DraftRegistryContext.Provider value={registry}>{children}</DraftRegistryContext.Provider>;
}
