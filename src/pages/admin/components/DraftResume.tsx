/** Lists unsaved drafts left from an earlier visit, with Resume and Discard. Renders nothing when there are none. */
export default function DraftResume({ items, onResume, onDiscard }: { items: { id: string; label: string }[]; onResume: (id: string) => void; onDiscard: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div role="status" className="mb-4 rounded-md border border-primary-200 bg-primary-50 px-4 py-3 text-sm text-primary-900">
      <p className="font-medium">Unsaved draft{items.length === 1 ? "" : "s"} from your last visit</p>
      <ul className="mt-1.5 space-y-1">
        {items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-3">
            <span>{item.label}</span>
            <button type="button" onClick={() => onResume(item.id)} className="cursor-pointer font-medium underline underline-offset-2">Resume</button>
            <button type="button" onClick={() => onDiscard(item.id)} className="cursor-pointer text-primary-800 underline underline-offset-2">Discard</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
