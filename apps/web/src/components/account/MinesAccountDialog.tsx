import { useState, type FormEvent } from "react";

import { useMinesAuth } from "../../cloud/MinesAuthProvider";
import { MinesAccountError } from "../../cloud/minesAccountClient";
import { isElectron } from "../../env";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

type AccountMode = "sign-in" | "sign-up" | "recover";

export function MinesAccountDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <AccountForm onClose={() => onOpenChange(false)} />
      </DialogPopup>
    </Dialog>
  );
}

function AccountForm({ onClose }: { readonly onClose: () => void }) {
  const auth = useMinesAuth();
  const [mode, setMode] = useState<AccountMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [verificationNeeded, setVerificationNeeded] = useState(false);
  const changeMode = (next: AccountMode) => {
    setMode(next);
    setPassword("");
    setError(null);
    setMessage(null);
    setVerificationNeeded(false);
  };
  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The account request could not be completed.",
      );
      setVerificationNeeded(
        cause instanceof MinesAccountError && cause.code === "EMAIL_NOT_VERIFIED",
      );
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void perform(async () => {
      const address = email.trim();
      if (mode === "recover") {
        await auth.requestPasswordReset(address);
        setMessage(
          "If an account exists for this address, a password reset link is on its way. Check your inbox and spam folder.",
        );
      } else if (mode === "sign-up") {
        const signedIn = await auth.signUp({ name: name.trim(), email: address, password });
        setPassword("");
        if (signedIn) onClose();
        else {
          setMode("sign-in");
          setVerificationNeeded(true);
          setMessage(
            "Your account was created. Check your inbox to verify your email, then sign in here.",
          );
        }
      } else {
        await auth.signIn({ email: address, password });
        setPassword("");
        onClose();
      }
    });
  };
  const resend = () =>
    void perform(async () => {
      await auth.sendVerificationEmail(auth.user?.email ?? email.trim());
      setMessage(
        "A verification link has been sent if this address needs verification. Check your inbox and spam folder.",
      );
    });
  const title = auth.isSignedIn
    ? "Your Mines account"
    : mode === "sign-up"
      ? "Create your Mines account"
      : mode === "recover"
        ? "Reset your password"
        : "Sign in to Mines";
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Your account connects your devices and keeps your workspace in sync.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        {auth.user ? (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium">{auth.user.name}</p>
              <p className="mt-1 break-all text-sm text-muted-foreground">{auth.user.email}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {auth.user.emailVerified ? "Email verified" : "Email verification pending"}
              </p>
            </div>
            {!auth.user.emailVerified ? (
              <Button variant="outline" disabled={busy} onClick={resend}>
                Resend verification email
              </Button>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                render={
                  <a
                    href={isElectron ? "#/settings/connections" : "/settings/connections"}
                    onClick={onClose}
                  />
                }
                variant="outline"
              >
                Manage devices
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await auth.requestPasswordReset(auth.user!.email);
                    setMessage("Check your inbox for a link to change your password.");
                  })
                }
              >
                Change password
              </Button>
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    await auth.signOut();
                    setPassword("");
                    onClose();
                  })
                }
              >
                {busy ? "Please wait…" : "Sign out"}
              </Button>
            </div>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            {mode === "sign-up" ? (
              <label className="block space-y-2">
                <span className="text-sm font-medium">Name</span>
                <Input
                  required
                  name="name"
                  autoComplete="name"
                  maxLength={100}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
            ) : null}
            <label className="block space-y-2">
              <span className="text-sm font-medium">Email</span>
              <Input
                required
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                disabled={busy}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            {mode !== "recover" ? (
              <label className="block space-y-2">
                <span className="text-sm font-medium">Password</span>
                <Input
                  required
                  name="password"
                  type="password"
                  autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                  minLength={mode === "sign-up" ? 12 : undefined}
                  maxLength={128}
                  value={password}
                  disabled={busy}
                  onChange={(event) => setPassword(event.target.value)}
                />
                {mode === "sign-up" ? (
                  <span className="text-xs text-muted-foreground">Use at least 12 characters.</span>
                ) : null}
              </label>
            ) : null}
            <Button type="submit" disabled={busy || !auth.isLoaded}>
              {busy
                ? "Please wait…"
                : mode === "sign-up"
                  ? "Create account"
                  : mode === "recover"
                    ? "Send reset link"
                    : "Sign in"}
            </Button>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => changeMode(mode === "sign-up" ? "sign-in" : "sign-up")}
              >
                {mode === "sign-up" ? "Already have an account? Sign in" : "Create an account"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => changeMode(mode === "recover" ? "sign-in" : "recover")}
              >
                {mode === "recover" ? "Back to sign in" : "Forgot password?"}
              </Button>
            </div>
          </form>
        )}
        {verificationNeeded && !auth.user ? (
          <Button variant="outline" size="sm" disabled={busy || !email.trim()} onClick={resend}>
            Resend verification email
          </Button>
        ) : null}
        {message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {message}
          </p>
        ) : null}
        {error || auth.error ? (
          <p role="alert" className="text-sm text-destructive">
            {error ?? auth.error}
          </p>
        ) : null}
      </DialogPanel>
    </>
  );
}
