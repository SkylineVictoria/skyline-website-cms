import { checkedDocumentCategory } from "../../supabase/functions/_shared/document-category";
import { uploadValidatedDocument } from "./validatedDocumentUpload";
import { supabase } from "@/pages/admin/lib/supabase";
import { bankIsEmpty, employeeDocPath, employeeFileProblem, type EmployeeBank, type EmployeeDetail, type EmployeeDocCategory, type EmployeeForm, type Employee, type EmployeeStatus } from "@/lib/employeeRules";

export * from "@/lib/employeeRules";

/**
 * Staff > Employees, simple (20261110170000): an Admin adds an employee (first name, last name, email, mobile) who is Active at once,
 * switches them between Active and Inactive, and uploads their documents by hand. Admin-only RPCs; files go straight to the private
 * staff-documents bucket under employees/<id>/ and are then recorded.
 */

/* ------------------------------------------------------------------ calls */

async function rpc<T>(name: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || fallback, { cause: error });
  return data as T;
}

export const listEmployees = (status: EmployeeStatus | "", search: string) =>
  rpc<Employee[]>("hr_admin_emp_list", { p_status: status || null, p_search: search.trim() || null }, "The employees could not be loaded.").then((r) => r ?? []);
export const getEmployee = (id: string) => rpc<EmployeeDetail>("hr_admin_emp_get", { p_id: id }, "The employee could not be loaded.");
/** Add (id null) or edit. Returns the employee id. */
export const saveEmployee = (id: string | null, form: EmployeeForm) =>
  rpc<string>("hr_admin_emp_save", { p_id: id, p_person: { firstName: form.firstName.trim(), lastName: form.lastName.trim(), email: form.email.trim().toLowerCase(), phone: form.phone.trim() } }, "The employee could not be saved.");
export const setEmployeeStatus = (id: string, status: EmployeeStatus) =>
  rpc<void>("hr_admin_emp_set_status", { p_id: id, p_status: status }, "The status could not be changed.");

/** Bank details for pay (Admin only), MASKED: BSB 06••••, account •••• 4321. null when none are saved. */
export const getEmployeeBank = (id: string) => rpc<EmployeeBank | null>("hr_admin_emp_bank_get", { p_id: id }, "The bank details could not be loaded.");
/** The bank details in full (Admin only). Every call is written to the person's history: who looked and when. */
export const revealEmployeeBank = (id: string) => rpc<EmployeeBank>("hr_admin_emp_bank_reveal", { p_id: id }, "The bank details could not be shown.");
/** Saves the bank details (stored encrypted; the answer is masked); all fields blank removes them. */
export const saveEmployeeBank = (id: string, bank: EmployeeBank) =>
  rpc<EmployeeBank | null>("hr_admin_emp_bank_save", { p_id: id, p_bank: bankIsEmpty(bank) ? {} : {
    accountName: bank.accountName.trim(), bsb: bank.bsb.replace(/[\s-]/g, ""), accountNumber: bank.accountNumber.replace(/[\s-]/g, ""), bankName: bank.bankName.trim() } },
  "The bank details could not be saved.");

/** Uploads the file to the employee's folder, then records it (a failed record removes the file again). */
export async function uploadEmployeeDocument(employeeId: string, category: EmployeeDocCategory, file: File): Promise<void> {
  const problem = employeeFileProblem(file);
  if (problem) throw new Error(problem);
  const bucket = supabase.storage.from("staff-documents");
  let path: string;
  if (checkedDocumentCategory(category)) {
    path = await uploadValidatedDocument("employee", employeeId, category, file);
  } else {
    path = employeeDocPath(employeeId, file.name, crypto.randomUUID().slice(0, 8));
    const { error } = await bucket.upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new Error("The file could not be uploaded. Please try again.");
  }
  try {
    await rpc<string>("hr_admin_emp_doc_add", { p_id: employeeId, p_category: category, p_path: path, p_filename: file.name, p_mime: file.type, p_size: file.size }, "The document could not be saved.");
  } catch (e) {
    await bucket.remove([path]);
    throw e;
  }
}

/** Removes a hand-uploaded document and its file. */
export async function removeEmployeeDocument(documentId: string): Promise<void> {
  const path = await rpc<string>("hr_admin_emp_doc_remove", { p_doc: documentId }, "The document could not be removed.");
  await supabase.storage.from("staff-documents").remove([path]); // best effort: the record is already gone
}

/** A short-lived link to view a document (the bucket is private). */
export async function employeeDocumentUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage.from("staff-documents").createSignedUrl(storagePath, 300);
  if (error || !data?.signedUrl) throw new Error("The document could not be opened.");
  return data.signedUrl;
}
