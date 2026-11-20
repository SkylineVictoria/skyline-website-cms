// hrRules: the lazily loaded rule getters (this file reaches the offline tests through enrolForm).
import { hrNumber, onHrRules } from "./hrRules";

/** The shortest password for students, agents and portal accounts: Business Rule auth.password_min_students_agents (10 until loaded). */
export let MIN_PASSWORD_LENGTH = 10;
onHrRules(() => { MIN_PASSWORD_LENGTH = Math.max(10, hrNumber("auth.password_min_students_agents", 10)); });

export function passwordProblem(password: string, confirmation?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (/skyline|slit/i.test(password)) return "Please avoid using the organisation name in your password.";
  if (confirmation !== undefined && password !== confirmation) return "The two passwords do not match.";
  return null;
}
