import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog } from "@/pages/admin/components/ui";
import PortalMenu from "@/pages/admin/components/PortalMenu";
import {
  type TableModel,
  type TableRow,
  parseBody,
  serializeBody,
  insertRowAt,
  deleteRowById,
  moveRow,
  nudgeRow,
  swapRows,
  insertColumnAt,
  deleteColumnById,
  renameColumn,
  nudgeColumn,
  swapColumns,
  isColumnPopulated,
  isRowPopulated,
} from "@/lib/tableModel";

/**
 * Model-driven table editor.
 *
 * The table model is the single source of truth while editing. Nothing is
 * written to Supabase until "Save Changes" (which the parent page handles).
 * All structure changes operate on the model — never on a live DOM selection —
 * so "Add Row Below" always anchors to the row you clicked and a column swap
 * moves its header AND every cell value together.
 */

interface Props {
  value: string;
  /** Change this when a different record is opened (e.g. the page id). */
  recordKey?: string;
  onChange: (html: string) => void;
  /** Persists the draft. Should resolve true on success, false on failure. */
  onSave?: () => Promise<boolean>;
  saving?: boolean;
  /** Notifies the parent (for close/navigation guards) when dirtiness changes. */
  onDirtyChange?: (dirty: boolean) => void;
  title?: string;
  hint?: string;
}

type MenuState = { kind: "row" | "col"; id: string; anchor: HTMLElement } | null;

/* ------------------------------------------------------------ Editable cell */

function EditableCell({
  html,
  placeholder,
  autoFocus,
  selected,
  onCommit,
  onFocusCell,
}: {
  html: string;
  placeholder?: string;
  autoFocus?: boolean;
  selected?: boolean;
  onCommit: (html: string) => void;
  onFocusCell: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const editing = useRef(false);

  // Only sync from props while the user is NOT actively editing this cell, so a
  // parent re-render can never clobber what is being typed.
  useEffect(() => {
    if (ref.current && !editing.current && ref.current.innerHTML !== (html || "")) {
      ref.current.innerHTML = html || "";
    }
  }, [html]);

  useEffect(() => {
    if (autoFocus && ref.current && document.activeElement !== ref.current) {
      ref.current.focus();
    }
  }, [autoFocus]);

  return (
    <div
      ref={ref}
      role="textbox"
      aria-label={placeholder || "Cell"}
      contentEditable
      suppressContentEditableWarning
      data-ph={placeholder ?? ""}
      onFocus={() => {
        editing.current = true;
        onFocusCell();
      }}
      onBlur={(e) => {
        editing.current = false;
        onCommit(e.currentTarget.innerHTML);
      }}
      onInput={(e) => onCommit(e.currentTarget.innerHTML)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          (e.currentTarget as HTMLDivElement).blur();
        }
      }}
      className={`tbl-cell min-w-[9rem] px-3 py-2 text-sm leading-snug text-foreground-900 outline-none ${
        selected ? "bg-primary-50/70" : ""
      }`}
    />
  );
}

/* ------------------------------------------------------------- Menu pieces */

function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wide text-foreground-400">
      {children}
    </p>
  );
}

function MenuItem({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-label hover:bg-background-100 ${
        danger ? "text-primary-700" : "text-foreground-700"
      }`}
    >
      <i className={`${icon} text-base`} aria-hidden="true" />
      {label}
    </button>
  );
}

/* ------------------------------------------------------------------ Editor */

export default function TableEditor({
  value,
  recordKey,
  onChange,
  onSave,
  saving = false,
  onDirtyChange,
  title = "Table",
  hint,
}: Props) {
  const initial = useRef<{ before: string; after: string; model: TableModel } | null>(null);
  if (!initial.current) {
    const p = parseBody(value);
    initial.current = { before: p.before, after: p.after, model: p.model };
  }
  const beforeRef = useRef(initial.current.before);
  const afterRef = useRef(initial.current.after);

  const [model, setModel] = useState<TableModel>(initial.current.model);
  const [savedModel, setSavedModel] = useState<TableModel>(initial.current.model);
  const [undoStack, setUndoStack] = useState<TableModel[]>([]);
  const [redoStack, setRedoStack] = useState<TableModel[]>([]);
  const [menu, setMenu] = useState<MenuState>(null);
  const [swapMode, setSwapMode] = useState(false);
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [selectedCol, setSelectedCol] = useState<string | null>(null);
  const [focusCell, setFocusCell] = useState<{ rowId: string; colId: string } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState<{ title: string; message: string; confirmLabel?: string; onConfirm: () => void } | null>(null);

  const labelRefs = useRef<Record<string, HTMLInputElement | null>>({});
  const cellBaseRef = useRef<TableModel | null>(null);
  const cellDirtyRef = useRef(false);
  const keyRef = useRef(recordKey);

  const emit = (next: TableModel) => {
    onChange(serializeBody(beforeRef.current, next, afterRef.current));
  };

  // Re-initialise ONLY when a genuinely different record is opened. Our own
  // onChange echoes back into `value`, so re-parsing on every value change would
  // destroy unsaved rows/columns — we deliberately key off `recordKey`, not value.
  useEffect(() => {
    if (keyRef.current === recordKey) return;
    keyRef.current = recordKey;
    const parsed = parseBody(value);
    beforeRef.current = parsed.before;
    afterRef.current = parsed.after;
    setModel(parsed.model);
    setSavedModel(parsed.model);
    setUndoStack([]);
    setRedoStack([]);
    setSelectedRow(null);
    setSelectedCol(null);
    setMenu(null);
    setSwapMode(false);
    setFocusCell(null);
    setSaveError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordKey]);

  /* ------------------------------------------------------------- history */

  const pushHistory = (snapshot: TableModel) => {
    setUndoStack((s) => [...s, snapshot].slice(-80));
    setRedoStack([]);
  };

  const commit = (next: TableModel) => {
    if (next === model) return;
    pushHistory(model);
    setModel(next);
    emit(next);
  };

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack(undoStack.slice(0, -1));
    setRedoStack([...redoStack, model]);
    setModel(prev);
    emit(prev);
  };

  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack(redoStack.slice(0, -1));
    setUndoStack([...undoStack, model]);
    setModel(next);
    emit(next);
  };

  const discard = () => {
    setModel(savedModel);
    emit(savedModel);
    setUndoStack([]);
    setRedoStack([]);
    setSaveError("");
  };

  /* ------------------------------------------------------------ cell edits */

  const setCell = (rowId: string, colId: string, html: string) => {
    const current = model.rows.find((r) => r.id === rowId)?.cells[colId] ?? "";
    if (current === html) return;
    if (!cellDirtyRef.current && cellBaseRef.current) {
      pushHistory(cellBaseRef.current);
      cellDirtyRef.current = true;
    }
    const next: TableModel = {
      ...model,
      rows: model.rows.map((r) => (r.id === rowId ? { ...r, cells: { ...r.cells, [colId]: html } } : r)),
    };
    setModel(next);
    emit(next);
  };

  const setLabel = (colId: string, label: string) => {
    if (!cellDirtyRef.current && cellBaseRef.current) {
      pushHistory(cellBaseRef.current);
      cellDirtyRef.current = true;
    }
    const next = renameColumn(model, colId, label);
    setModel(next);
    emit(next);
  };

  /* ------------------------------------------------------------- row actions */

  const closeMenu = () => {
    setMenu(null);
    setSwapMode(false);
  };

  const addRowAt = (at: number) => {
    const pos = Math.max(0, Math.min(at, model.rows.length));
    const next = insertRowAt(model, pos);
    closeMenu();
    commit(next);
    const newRow = next.rows[pos];
    if (newRow && next.columns[0]) setFocusCell({ rowId: newRow.id, colId: next.columns[0].id });
  };

  const requestDeleteRow = (row: TableRow) => {
    closeMenu();
    const run = () => {
      commit(deleteRowById(model, row.id));
      setPending(null);
    };
    if (isRowPopulated(row)) {
      setPending({
        title: "Delete row",
        message: "This row has content that will be removed from the table (until you save). Delete it?",
        confirmLabel: "Delete row",
        onConfirm: run,
      });
    } else {
      run();
    }
  };

  const requestDeleteColumn = (colId: string, label: string) => {
    closeMenu();
    const run = () => {
      commit(deleteColumnById(model, colId));
      setPending(null);
    };
    if (isColumnPopulated(model, colId)) {
      setPending({
        title: "Delete column",
        message: `Column "${label}" has data that will be removed from every row (until you save). Delete it?`,
        confirmLabel: "Delete column",
        onConfirm: run,
      });
    } else {
      run();
    }
  };

  const startTable = () => {
    let next = model;
    if (next.columns.length === 0) next = insertColumnAt(next, 0);
    next = insertRowAt(next, next.rows.length);
    commit(next);
  };

  /* ------------------------------------------------------------- save/discard */

  const handleSave = async () => {
    if (!onSave || saving) return;
    setSaveError("");
    try {
      const ok = await onSave();
      if (ok) {
        setSavedModel(model);
        setUndoStack([]);
        setRedoStack([]);
      } else {
        setSaveError("Save failed. Your edits are kept — please try again.");
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Save failed. Your edits are kept — please try again.");
    }
  };

  const requestDiscard = () => {
    if (!dirty) return;
    setPending({
      title: "Discard changes",
      message: "Discard all unsaved table changes and restore the last saved version?",
      confirmLabel: "Discard changes",
      onConfirm: () => {
        discard();
        setPending(null);
      },
    });
  };

  /* ---------------------------------------------------------------- derived */

  const dirty = useMemo(
    () =>
      serializeBody(beforeRef.current, model, afterRef.current) !==
      serializeBody(beforeRef.current, savedModel, afterRef.current),
    [model, savedModel],
  );

  const empty = model.columns.length === 0;

  // Let the parent guard closes while there are unsaved changes.
  useEffect(() => {
    onDirtyChange?.(dirty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);

  // Warn before a browser refresh/close while there are unsaved changes.
  useEffect(() => {
    if (!dirty) return undefined;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const status: { label: string; icon: string; tone: string } = saving
    ? { label: "Saving…", icon: "ri-loader-4-line animate-spin", tone: "bg-primary-100 text-primary-800" }
    : saveError
      ? { label: "Save failed", icon: "ri-error-warning-line", tone: "bg-primary-100 text-primary-800" }
      : dirty
        ? { label: "Unsaved changes", icon: "ri-edit-2-line", tone: "bg-accent-100 text-accent-900" }
        : { label: "All changes saved", icon: "ri-check-line", tone: "bg-background-200 text-foreground-600" };

  const menuRow = menu?.kind === "row" ? model.rows.find((r) => r.id === menu.id) ?? null : null;
  const menuRowIndex = menuRow ? model.rows.findIndex((r) => r.id === menuRow.id) : -1;
  const menuCol = menu?.kind === "col" ? model.columns.find((c) => c.id === menu.id) ?? null : null;
  const menuColIndex = menuCol ? model.columns.findIndex((c) => c.id === menuCol.id) : -1;

  return (
    <div className="rounded-md border border-background-300 bg-background-50">
      {/* Header / toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-md border-b border-background-200 bg-background-100 px-3 py-2">
        <div className="flex items-center gap-2 text-label font-medium text-foreground-700">
          <i className="ri-table-2 text-base text-foreground-500" aria-hidden="true" />
          {title}
          <span className="text-foreground-400">
            {model.columns.length} column{model.columns.length === 1 ? "" : "s"} · {model.rows.length} row
            {model.rows.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${status.tone}`}>
            <i className={status.icon} aria-hidden="true" />
            {status.label}
          </span>
          <button
            type="button"
            onClick={undo}
            disabled={undoStack.length === 0}
            title="Undo"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-2.5 py-1 text-xs font-medium text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <i className="ri-arrow-go-back-line" aria-hidden="true" />
            Undo
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={redoStack.length === 0}
            title="Redo"
            className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-2.5 py-1 text-xs font-medium text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <i className="ri-arrow-go-forward-line" aria-hidden="true" />
            Redo
          </button>
          {onSave ? (
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary-500 px-3 py-1 text-xs font-medium text-background-50 hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <i className={saving ? "ri-loader-4-line animate-spin" : "ri-save-3-line"} aria-hidden="true" />
              {saving ? "Saving…" : "Save changes"}
            </button>
          ) : null}
          {onSave ? (
            <button
              type="button"
              onClick={requestDiscard}
              disabled={!dirty || saving}
              className="inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-2.5 py-1 text-xs font-medium text-foreground-700 hover:bg-background-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <i className="ri-restart-line" aria-hidden="true" />
              Discard
            </button>
          ) : null}
        </div>
      </div>

      {saveError ? (
        <p className="flex items-center gap-1.5 border-b border-primary-200 bg-primary-50 px-3 py-2 text-xs text-primary-800" role="alert">
          <i className="ri-error-warning-line" aria-hidden="true" />
          {saveError}
        </p>
      ) : null}

      {empty ? (
        <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-background-100 text-foreground-400">
            <i className="ri-table-2 text-2xl" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium text-foreground-800">This table has no columns yet</p>
          <p className="max-w-sm text-xs text-foreground-500">
            Add a column to start building the table, then add rows for each entry.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => commit(insertColumnAt(model, model.columns.length))}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-sm font-medium text-foreground-800 hover:bg-background-100"
            >
              <i className="ri-insert-column-right" aria-hidden="true" />
              Add Column
            </button>
            <button
              type="button"
              onClick={startTable}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary-500 px-3 py-1.5 text-sm font-medium text-background-50 hover:bg-primary-600"
            >
              <i className="ri-add-line" aria-hidden="true" />
              Add Row
            </button>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-sm">
            <thead>
              <tr className="bg-secondary-100">
                <th className="w-11 border-b border-background-200 px-2 py-2" aria-label="Row actions" />
                {model.columns.map((col) => (
                  <th
                    key={col.id}
                    scope="col"
                    className={`border-b border-l border-background-200 px-2 py-2 align-top ${
                      selectedCol === col.id ? "bg-primary-100/60" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1">
                      <input
                        ref={(el) => {
                          labelRefs.current[col.id] = el;
                        }}
                        value={col.label}
                        onFocus={() => {
                          setSelectedCol(col.id);
                          cellBaseRef.current = model;
                          cellDirtyRef.current = false;
                        }}
                        onChange={(e) => setLabel(col.id, e.target.value)}
                        onBlur={() => {
                          cellDirtyRef.current = false;
                        }}
                        aria-label="Column name"
                        className="w-full min-w-[6rem] bg-transparent text-xs font-semibold uppercase tracking-wide text-secondary-900 outline-none focus:text-foreground-950"
                      />
                      <button
                        type="button"
                        aria-label={`Column actions for ${col.label}`}
                        aria-haspopup="menu"
                        onClick={(e) => {
                          if (menu?.kind === "col" && menu.id === col.id) {
                            closeMenu();
                          } else {
                            setSwapMode(false);
                            setSelectedCol(col.id);
                            setMenu({ kind: "col", id: col.id, anchor: e.currentTarget });
                          }
                        }}
                        className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-200"
                      >
                        <i className="ri-more-2-fill" aria-hidden="true" />
                      </button>
                    </div>
                  </th>
                ))}
                <th className="border-b border-l border-background-200 px-2 py-2" aria-label="Add column">
                  <button
                    type="button"
                    onClick={() => commit(insertColumnAt(model, model.columns.length))}
                    aria-label="Add column at end"
                    title="Add column at end"
                    className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-200"
                  >
                    <i className="ri-add-line" aria-hidden="true" />
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {model.rows.length === 0 ? (
                <tr>
                  <td colSpan={model.columns.length + 2} className="px-4 py-6 text-center text-sm text-foreground-500">
                    No rows yet — use “Add Row at End” below.
                  </td>
                </tr>
              ) : (
                model.rows.map((row, index) => (
                  <tr
                    key={row.id}
                    className={`border-t border-background-200 align-top ${
                      selectedRow === row.id ? "bg-primary-50/40" : ""
                    }`}
                  >
                    <td className="border-l border-background-200 px-1 py-1.5">
                      <div className="flex items-center justify-center">
                        <button
                          type="button"
                          aria-label={`Row ${index + 1} actions`}
                          aria-haspopup="menu"
                          onClick={(e) => {
                            if (menu?.kind === "row" && menu.id === row.id) {
                              closeMenu();
                            } else {
                              setSwapMode(false);
                              setSelectedRow(row.id);
                              setMenu({ kind: "row", id: row.id, anchor: e.currentTarget });
                            }
                          }}
                          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-foreground-500 hover:bg-background-100"
                        >
                          <i className="ri-more-2-fill" aria-hidden="true" />
                        </button>
                      </div>
                    </td>
                    {model.columns.map((col) => (
                      <td
                        key={col.id}
                        className={`border-l border-background-200 p-0 ${
                          selectedCol === col.id ? "bg-primary-50/30" : ""
                        }`}
                      >
                        <EditableCell
                          html={row.cells[col.id] ?? ""}
                          placeholder={col.label}
                          autoFocus={focusCell?.rowId === row.id && focusCell?.colId === col.id}
                          selected={selectedRow === row.id}
                          onFocusCell={() => {
                            setSelectedRow(row.id);
                            setSelectedCol(col.id);
                            cellBaseRef.current = model;
                            cellDirtyRef.current = false;
                            if (focusCell) setFocusCell(null);
                          }}
                          onCommit={(html) => setCell(row.id, col.id, html)}
                        />
                      </td>
                    ))}
                    <td className="border-l border-background-200" />
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer actions */}
      {!empty ? (
        <div className="flex flex-wrap items-center gap-2 rounded-b-md border-t border-background-200 bg-background-100 px-3 py-2.5">
          <button
            type="button"
            onClick={() => addRowAt(model.rows.length)}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md bg-primary-500 px-3 py-1.5 text-sm font-medium text-background-50 hover:bg-primary-600"
          >
            <i className="ri-add-line" aria-hidden="true" />
            Add Row at End
          </button>
          <button
            type="button"
            onClick={() => commit(insertColumnAt(model, model.columns.length))}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-background-300 bg-background-50 px-3 py-1.5 text-sm font-medium text-foreground-800 hover:bg-background-200"
          >
            <i className="ri-insert-column-right" aria-hidden="true" />
            Add Column
          </button>
          <span className="ml-auto hidden text-2xs text-foreground-400 sm:block">
            Tip: open the ⋮ menu on a row or column header for insert, move, swap, rename and delete.
          </span>
        </div>
      ) : null}

      {hint ? <p className="border-t border-background-200 px-3 py-2 text-xs text-foreground-500">{hint}</p> : null}

      {/* Row context menu (portaled so it is never clipped) */}
      {menu?.kind === "row" && menuRow ? (
        <PortalMenu anchor={menu.anchor} onClose={closeMenu} width={240}>
          <MenuLabel>Row {menuRowIndex + 1}</MenuLabel>
          {swapMode ? (
            <>
              <MenuLabel>Swap with</MenuLabel>
              {model.rows.filter((r) => r.id !== menuRow.id).length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-foreground-400">No other row</p>
              ) : (
                model.rows
                  .map((other, oi) => ({ other, oi }))
                  .filter(({ other }) => other.id !== menuRow.id)
                  .slice(0, 40)
                  .map(({ other, oi }) => (
                    <MenuItem
                      key={other.id}
                      icon="ri-swap-box-line"
                      label={`Row ${oi + 1}`}
                      onClick={() => {
                        closeMenu();
                        commit(swapRows(model, menuRow.id, other.id));
                      }}
                    />
                  ))
              )}
              <div className="my-1 border-t border-background-200" />
              <MenuItem icon="ri-arrow-left-line" label="Back" onClick={() => setSwapMode(false)} />
            </>
          ) : (
            <>
              <MenuItem icon="ri-insert-row-top" label="Add row above" onClick={() => addRowAt(menuRowIndex)} />
              <MenuItem icon="ri-insert-row-bottom" label="Add row below" onClick={() => addRowAt(menuRowIndex + 1)} />
              <MenuItem icon="ri-add-line" label="Add row at end" onClick={() => addRowAt(model.rows.length)} />
              <div className="my-1 border-t border-background-200" />
              <MenuItem
                icon="ri-arrow-up-line"
                label="Move row up"
                onClick={() => {
                  closeMenu();
                  commit(nudgeRow(model, menuRow.id, -1));
                }}
              />
              <MenuItem
                icon="ri-arrow-down-line"
                label="Move row down"
                onClick={() => {
                  closeMenu();
                  commit(nudgeRow(model, menuRow.id, 1));
                }}
              />
              <MenuItem
                icon="ri-arrow-up-double-line"
                label="Move to top"
                onClick={() => {
                  closeMenu();
                  commit(moveRow(model, menuRow.id, 0));
                }}
              />
              <MenuItem
                icon="ri-arrow-down-double-line"
                label="Move to bottom"
                onClick={() => {
                  closeMenu();
                  commit(moveRow(model, menuRow.id, model.rows.length - 1));
                }}
              />
              <MenuItem icon="ri-swap-box-line" label="Swap with…" onClick={() => setSwapMode(true)} />
              <div className="my-1 border-t border-background-200" />
              <MenuItem icon="ri-delete-bin-line" label="Delete row" danger onClick={() => requestDeleteRow(menuRow)} />
            </>
          )}
        </PortalMenu>
      ) : null}

      {/* Column context menu */}
      {menu?.kind === "col" && menuCol ? (
        <PortalMenu anchor={menu.anchor} onClose={closeMenu} width={240}>
          <MenuLabel>{menuCol.label}</MenuLabel>
          {swapMode ? (
            <>
              <MenuLabel>Swap with</MenuLabel>
              {model.columns.filter((c) => c.id !== menuCol.id).length === 0 ? (
                <p className="px-3 py-1.5 text-xs text-foreground-400">No other column</p>
              ) : (
                model.columns
                  .filter((c) => c.id !== menuCol.id)
                  .map((other) => (
                    <MenuItem
                      key={other.id}
                      icon="ri-swap-box-line"
                      label={other.label}
                      onClick={() => {
                        closeMenu();
                        commit(swapColumns(model, menuCol.id, other.id));
                      }}
                    />
                  ))
              )}
              <div className="my-1 border-t border-background-200" />
              <MenuItem icon="ri-arrow-left-line" label="Back" onClick={() => setSwapMode(false)} />
            </>
          ) : (
            <>
              <MenuItem
                icon="ri-insert-column-left"
                label="Add column left"
                onClick={() => {
                  closeMenu();
                  commit(insertColumnAt(model, menuColIndex));
                }}
              />
              <MenuItem
                icon="ri-insert-column-right"
                label="Add column right"
                onClick={() => {
                  closeMenu();
                  commit(insertColumnAt(model, menuColIndex + 1));
                }}
              />
              <MenuItem
                icon="ri-add-line"
                label="Add column at end"
                onClick={() => {
                  closeMenu();
                  commit(insertColumnAt(model, model.columns.length));
                }}
              />
              <div className="my-1 border-t border-background-200" />
              <MenuItem
                icon="ri-text"
                label="Rename column"
                onClick={() => {
                  closeMenu();
                  const el = labelRefs.current[menuCol.id];
                  el?.focus();
                  el?.select();
                }}
              />
              <MenuItem
                icon="ri-arrow-left-line"
                label="Move column left"
                onClick={() => {
                  closeMenu();
                  commit(nudgeColumn(model, menuCol.id, -1));
                }}
              />
              <MenuItem
                icon="ri-arrow-right-line"
                label="Move column right"
                onClick={() => {
                  closeMenu();
                  commit(nudgeColumn(model, menuCol.id, 1));
                }}
              />
              <MenuItem icon="ri-swap-box-line" label="Swap with…" onClick={() => setSwapMode(true)} />
              <div className="my-1 border-t border-background-200" />
              <MenuItem
                icon="ri-delete-bin-line"
                label="Delete column"
                danger
                onClick={() => requestDeleteColumn(menuCol.id, menuCol.label)}
              />
            </>
          )}
        </PortalMenu>
      ) : null}

      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ""}
        message={pending?.message ?? ""}
        confirmLabel={pending?.confirmLabel ?? "Confirm"}
        onConfirm={() => pending?.onConfirm()}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}