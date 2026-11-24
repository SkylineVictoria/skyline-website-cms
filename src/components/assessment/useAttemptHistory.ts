import { useEffect, useState } from "react";
import { historyFromAttempts, type AttemptHistory } from "@/lib/assessment/resultsSheet";
import { attemptHistory } from "@/lib/assessment/api";
import type { Attempt } from "@/lib/assessment/types";

/**
 * ASM-WORKBOOK: the attempt's full history (asm_attempt_history) for the results sheet and the PDF export, reloaded when
 * `refreshKey` changes (after marks are saved). Until the database has the function, or when it fails, the attempts the page
 * already has are used (no assessor names).
 */
export function useAttemptHistory(attemptId: string | null | undefined, loaded: Attempt[], studentName: string | null | undefined, refreshKey: unknown): AttemptHistory | null {
  const [history, setHistory] = useState<AttemptHistory | null>(null);
  const fallbackKey = loaded.map((a) => `${a.id}:${a.state}:${a.rowVersion}`).join(",");
  useEffect(() => {
    if (!attemptId) { setHistory(null); return undefined; }
    let live = true;
    const fallback = () => historyFromAttempts(loaded, { studentName });
    attemptHistory(attemptId).then((h) => { if (live) setHistory(h ?? fallback()); }).catch(() => { if (live) setHistory(fallback()); });
    return () => { live = false; };
  }, [attemptId, refreshKey, fallbackKey, studentName]); // eslint-disable-line react-hooks/exhaustive-deps
  return history;
}
