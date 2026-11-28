import AxcelerateRecordImport from '@/components/axcelerate/AxcelerateRecordImport';

/** Students page: "Import from aXcelerate" (AXCELERATE-STUDENTS): one student by search, or all students (see AxcelerateRecordImport). */
export default function AxcelerateStudentsImport({ onDone }: { onDone?: () => void }) {
  return <AxcelerateRecordImport kind="students" onDone={onDone} />;
}
