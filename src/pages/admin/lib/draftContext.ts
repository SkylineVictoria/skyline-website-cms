import { createContext, useContext } from "react";

/** Which mounted CMS editors currently hold unsaved changes. The provider (AdminLayout) uses it to warn before leaving. */
export interface DraftRegistry {
  setDirty(key: string, dirty: boolean): void;
  clear(key: string): void;
  anyDirty(): boolean;
}

export const DraftRegistryContext = createContext<DraftRegistry | null>(null);
export const useDraftRegistry = () => useContext(DraftRegistryContext);
