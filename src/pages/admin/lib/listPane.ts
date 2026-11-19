// Whether a page's list column is folded into a rail (remembered per page in this browser), and the grid columns that go with it.
import { useCallback, useState } from "react";

const read = (key: string) => { try { return window.localStorage.getItem("list-pane:" + key) === "folded"; } catch { return false; } };

export const paneGrid = (folded: boolean) => (folded ? "lg:grid-cols-[48px_minmax(0,1fr)]" : "lg:grid-cols-[320px_minmax(0,1fr)]");

export interface Pane { folded: boolean; toggle: () => void; grid: string }

/** The pane's state and the grid columns to use for the page: `<div className={"grid items-start gap-5 " + pane.grid}>`. */
export function useListPane(key: string): Pane {
  const [folded, setFolded] = useState(() => read(key));
  const toggle = useCallback(() => setFolded(value => {
    const next = !value;
    try { window.localStorage.setItem("list-pane:" + key, next ? "folded" : "open"); } catch { /* private mode: not remembered */ }
    return next;
  }), [key]);
  return { folded, toggle, grid: paneGrid(folded) };
}
