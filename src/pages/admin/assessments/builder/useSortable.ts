import { useState, type DragEvent } from "react";

/**
 * Drag-and-drop reordering with the browser's own drag events (no extra dependency): each item has a handle; dropping on another
 * item of the same list moves it there. Keyboard users get the up/down buttons the callers render beside the handle.
 */
export function useSortable(listId: string, onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const handleProps = (index: number) => ({
    draggable: true,
    onDragStart: (e: DragEvent) => { e.dataTransfer.setData("text/plain", `${listId}:${index}`); e.dataTransfer.effectAllowed = "move"; setDragging(index); },
    onDragEnd: () => { setDragging(null); setOver(null); },
  });
  const itemProps = (index: number) => ({
    onDragOver: (e: DragEvent) => { if (!e.dataTransfer.types.includes("text/plain")) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (over !== index) setOver(index); },
    onDragLeave: () => { if (over === index) setOver(null); },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      const data = e.dataTransfer.getData("text/plain"); const [id, from] = data.split(":");
      setDragging(null); setOver(null);
      if (id !== listId) return;
      const f = Number(from); if (Number.isNaN(f) || f === index) return;
      onMove(f, index);
    },
    className: over === index && dragging !== index ? "ring-2 ring-primary-300" : "",
  });
  return { handleProps, itemProps, dragging };
}
