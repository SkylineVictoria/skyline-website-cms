/** UNIT-DOCS: Sign templates linked to a course unit and sent to a batch for signature (public.unit_documents). */
import { supabase } from "@/pages/admin/lib/supabase";
import { signingAction, type SigningRole } from "@/lib/signingApi";

export interface UnitTemplateLink { templateId: string; courseId: string; unitId: string; unitCode: string; unitName: string }
export interface UnitDocumentSend { studentId: string; requestId: string | null; sentAt: string; state: string | null; reference: string | null }
export interface UnitDocumentTemplate { templateId: string; name: string; title: string; version: number; roles: SigningRole[]; sends: UnitDocumentSend[] }

export async function unitDocuments<T>(action: string, data: Record<string, unknown> = {}): Promise<T> {
  const result = await supabase.rpc("unit_documents", { p_action: action, p_data: data });
  if (result.error) throw new Error(result.error.message);
  return result.data as T;
}

/** One signing request per student, sent at once; the student signs as the template's first signer. */
export async function sendUnitDocument(template: UnitDocumentTemplate, batchId: string, student: { id: string; name: string; email: string }): Promise<void> {
  const roles = [...(template.roles ?? [])].sort((a, b) => a.order - b.order);
  if (roles.length > 1) throw new Error(`"${template.name}" has ${roles.length} signers. A unit document sent to a batch must have the student as its only signer.`);
  const role = roles[0];
  const created = await signingAction<{ id: string }>({
    action: "create", templateId: template.templateId, subjectType: "student", subjectId: student.id,
    recipients: [{ name: student.name, email: student.email, role: role?.key ?? "student", label: role?.label ?? "Student", order: 1, required: true }],
  });
  await unitDocuments("send_record", { templateId: template.templateId, batchId, studentId: student.id, requestId: created.id });
  await signingAction({ action: "send", id: created.id });
}
