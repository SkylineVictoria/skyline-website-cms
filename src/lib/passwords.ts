export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblem(password: string, confirmation?: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Please choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (/skyline|slit/i.test(password)) return "Please avoid using the organisation name in your password.";
  if (confirmation !== undefined && password !== confirmation) return "The two passwords do not match.";
  return null;
}
