import { supabase } from "@/pages/admin/lib/supabase";
import type { StaffRole } from "@/lib/staffStatus";

/** A staff role (HRMS): Trainer and Admin are built in; others are added by an Admin and take the system access of one of them. */
export interface StaffRoleType { key: string; label: string; access: StaffRole; system: boolean }

export async function listStaffRoleTypes(): Promise<StaffRoleType[]> {
  const { data, error } = await supabase.rpc("hr_admin_role_types");
  if (error) throw new Error(error.message);
  return (data ?? []) as StaffRoleType[];
}

/** Adds a role, or returns the existing one with that name (existing: true). */
export async function addStaffRoleType(label: string, access: StaffRole): Promise<StaffRoleType & { existing: boolean }> {
  const { data, error } = await supabase.rpc("hr_admin_role_type_add", { p_label: label, p_access: access });
  if (error) throw new Error(error.message);
  return data as StaffRoleType & { existing: boolean };
}
