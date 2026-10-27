import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useAuth } from "@/pages/admin/lib/authContext";
import { AdminLoading, Button, Field, TextInput } from "@/pages/admin/components/ui";
import { hadSession, loginUrl } from "@/lib/loginRouting";

const MIN_LENGTH = 10;

/**
 * Forced password rotation only (e.g. an account flagged after its credentials
 * were exposed). Email-based password recovery does NOT land here — every
 * recovery link (login "Forgot password?", admin-issued reset, and invites)
 * is handled by the single shared /reset-password screen instead.
 */
export default function AdminSetPasswordPage() {
  const { user, authLoading, changePassword, logout } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (authLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background-100">
        <AdminLoading label="Checking your session…" />
      </div>
    );
  }

  // No session (e.g. an expired reset link) → back to sign in.
  if (!user) return <Navigate to={loginUrl("/admin", hadSession())} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password.length < MIN_LENGTH) {
      setError(`Please choose a password of at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    if (password.toLowerCase().includes("slit") || password.toLowerCase().includes("skyline")) {
      setError("Please avoid using the organisation name in your password.");
      return;
    }
    setLoading(true);
    const res = await changePassword(password);
    setLoading(false);
    if (res.ok) {
      navigate("/admin", { replace: true });
    } else {
      setError(res.error ?? "Could not update your password.");
    }
  };

  return (
    <div className="flex min-h-screen bg-background-100">
      <div className="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-primary-500 p-10 text-background-50 lg:flex">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-background-50/20">
            <i className="ri-shield-keyhole-line text-xl" aria-hidden="true" />
          </span>
          <span className="font-heading text-lg font-bold">Skyline Institute of Technology</span>
        </div>
        <div>
          <h1 className="font-heading text-3xl font-bold leading-tight">
            Protect your
            <br />
            CMS account
          </h1>
          <p className="mt-4 max-w-md text-sm text-background-50/85">
            Choose a strong, unique password that you don&rsquo;t use anywhere else. Your previous
            credentials are no longer valid once you set a new one.
          </p>
        </div>
        <p className="text-xs text-background-50/70">RTO 45989 &middot; CRICOS 04114B</p>
        <div className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full bg-background-50/10" />
        <div className="pointer-events-none absolute -bottom-24 right-10 h-72 w-72 rounded-full bg-background-50/10" />
      </div>

      <div className="flex w-full flex-1 items-center justify-center px-5 py-10 lg:w-[54%]">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-6 inline-flex items-center gap-1.5 text-sm font-medium text-foreground-600 hover:text-primary-700"><i className="ri-arrow-left-line" aria-hidden="true" />Back to site</Link>
          <h2 className="font-heading text-2xl font-bold text-foreground-950">Set a new password</h2>
          <p className="mt-1.5 text-sm text-foreground-600">
            {user.mustChangePassword
              ? "Your account is required to change its password before continuing."
              : "Choose a new password for your account."}
          </p>

          <form onSubmit={submit} className="mt-7 space-y-4">
            <Field label="New password" required hint={`At least ${MIN_LENGTH} characters.`}>
              <TextInput
                type="password"
                name="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter a new password"
                autoComplete="new-password"
              />
            </Field>

            <Field label="Confirm new password" required>
              <TextInput
                type="password"
                name="confirm-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Re-enter the new password"
                autoComplete="new-password"
              />
            </Field>

            {error ? (
              <div className="flex items-start gap-2 rounded-md border border-primary-200 bg-primary-50 px-3 py-2.5 text-[13px] text-primary-900">
                <i className="ri-error-warning-line mt-0.5 text-base" aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={loading} icon={loading ? undefined : "ri-lock-password-line"}>
              {loading ? "Saving…" : "Save new password"}
            </Button>
          </form>

          <div className="mt-6 flex items-center justify-between text-xs text-foreground-500">
            <span className="truncate">Signed in as {user.email}</span>
            <button
              type="button"
              onClick={() => {
                void logout();
              }}
              className="cursor-pointer font-medium text-primary-700 hover:text-primary-800"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}