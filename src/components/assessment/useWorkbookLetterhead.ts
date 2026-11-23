/**
 * ASM-HEADER: the workbook letterhead (header picture + address block) for a screen, read again whenever Assessments > Settings
 * or the wizard changes the header (HEADER_EVENT), so every open preview shows the new picture without a reload.
 */
import { useEffect, useState } from "react";
import { HEADER_EVENT, workbookHeaderSetting, workbookLetterhead, type WorkbookHeaderSetting, type WorkbookLetterhead } from "@/lib/assessment/workbookExport";

export function useWorkbookLetterhead(): { head: WorkbookLetterhead | null; setting: WorkbookHeaderSetting | null } {
  const [head, setHead] = useState<WorkbookLetterhead | null>(null);
  const [setting, setSetting] = useState<WorkbookHeaderSetting | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      void workbookLetterhead().then((h) => { if (live) setHead(h); }).catch(() => undefined);
      void workbookHeaderSetting().then((s) => { if (live) setSetting(s); }).catch(() => undefined);
    };
    read();
    window.addEventListener(HEADER_EVENT, read);
    return () => { live = false; window.removeEventListener(HEADER_EVENT, read); };
  }, []);
  return { head, setting };
}
