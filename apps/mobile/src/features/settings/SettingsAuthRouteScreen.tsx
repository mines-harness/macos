import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Button } from "../../components/ui/Button";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useMinesAccount } from "../cloud/MinesAccountProvider";
import { hasCloudPublicConfig, hasMinesIdentityConfig } from "../cloud/publicConfig";
import { T3ConnectProfilePage } from "../cloud/T3ConnectProfilePage";
import { ConnectionFormField } from "../connection/ConnectionFormField";
import { SettingsScreen } from "./components/SettingsScreen";

type FormMode = "sign-in" | "sign-up" | "reset";

export function SettingsAuthRouteScreen() {
  return hasMinesIdentityConfig() ? <ConfiguredSettingsAuthRouteScreen /> : null;
}

function ConfiguredSettingsAuthRouteScreen() {
  const account = useMinesAccount();
  const navigation = useNavigation();
  const [mode, setMode] = useState<FormMode>("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showServers, setShowServers] = useState(false);
  const changeMode = (next: FormMode) => {
    setMode(next);
    setPassword("");
    setError(null);
    setMessage(null);
  };
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the account service.");
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    void run(async () => {
      if (mode === "sign-up") {
        await account.signUp(name, email, password);
        setPassword("");
        setMode("sign-in");
        setMessage(
          account.emailVerificationRequired
            ? "Check your email to verify your account, then sign in here."
            : "Account created. Sign in to connect your devices.",
        );
      } else if (mode === "reset") {
        await account.requestPasswordReset(email);
        setMessage("If this email has an account, a password reset link is on its way.");
      } else {
        await account.signIn(email, password);
        setPassword("");
      }
    });
  };

  if (showServers && account.isSignedIn) {
    return (
      <SettingsScreen title="Registered servers">
        <View className="px-5 pt-4">
          <Button label="Back to account" tone="text" onPress={() => setShowServers(false)} />
        </View>
        <T3ConnectProfilePage />
      </SettingsScreen>
    );
  }

  const title = account.isSignedIn
    ? "mines account"
    : mode === "sign-up"
      ? "Create account"
      : mode === "reset"
        ? "Reset password"
        : "Sign in";
  return (
    <SettingsScreen title={title}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-5 px-5 pt-6 pb-10"
      >
        {!account.isLoaded ? (
          <AppActivityIndicator colorClassName="accent-foreground-muted" />
        ) : account.isSignedIn ? (
          <>
            <View className="gap-2">
              <Text className="text-2xl font-mines-bold text-foreground">{account.user?.name}</Text>
              <Text selectable className="text-base text-foreground-muted">
                {account.user?.email}
              </Text>
              {account.user?.emailVerified ? (
                <Text className="text-sm text-foreground-muted">Email verified</Text>
              ) : null}
            </View>
            <Text className="text-base text-foreground-muted">
              Sign in with this account on your other devices to find your approved computers.
            </Text>
            <Button
              label="Manage devices"
              fullWidth
              onPress={() => navigation.navigate("SettingsEnvironments")}
            />
            {hasCloudPublicConfig() ? (
              <Button label="Registered servers" fullWidth onPress={() => setShowServers(true)} />
            ) : null}
            <Button
              label="Sign out"
              tone="danger"
              fullWidth
              loading={busy}
              onPress={() => {
                void run(account.signOut);
              }}
            />
          </>
        ) : (
          <>
            <Text className="text-base text-foreground-muted">
              {mode === "reset"
                ? "Enter your email to receive a password reset link."
                : "Use the same mines account on your Mac, phone, and web browser."}
            </Text>
            {mode === "sign-up" ? (
              <ConnectionFormField
                label="Name"
                value={name}
                onChangeText={setName}
                autoComplete="name"
                textContentType="name"
                editable={!busy}
              />
            ) : null}
            <ConnectionFormField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              autoComplete="email"
              textContentType="emailAddress"
              editable={!busy}
            />
            {mode !== "reset" ? (
              <ConnectionFormField
                label="Password"
                value={password}
                onChangeText={setPassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                textContentType={mode === "sign-up" ? "newPassword" : "password"}
                editable={!busy}
                onSubmitEditing={submit}
                returnKeyType="go"
              />
            ) : null}
            {mode === "sign-up" ? (
              <Text className="text-sm text-foreground-muted">
                Use at least 12 characters.
                {account.emailVerificationRequired ? " Verify your email before signing in." : ""}
              </Text>
            ) : null}
            <Button
              label={
                mode === "sign-up"
                  ? "Create account"
                  : mode === "reset"
                    ? "Send reset link"
                    : "Sign in"
              }
              tone="primary"
              fullWidth
              loading={busy}
              disabled={
                !email.trim() ||
                (mode !== "reset" && !password) ||
                (mode === "sign-up" && (!name.trim() || password.length < 12))
              }
              onPress={submit}
            />
            <Button
              label={mode === "sign-in" ? "Create an account" : "Back to sign in"}
              tone="text"
              fullWidth
              disabled={busy}
              onPress={() => changeMode(mode === "sign-in" ? "sign-up" : "sign-in")}
            />
            {mode === "sign-in" ? (
              <>
                {account.passwordResetEnabled ? (
                  <Button
                    label="Forgot password?"
                    tone="text"
                    fullWidth
                    disabled={busy}
                    onPress={() => changeMode("reset")}
                  />
                ) : null}
                {account.emailVerificationRequired ? (
                  <Button
                    label="Resend verification email"
                    tone="text"
                    fullWidth
                    disabled={busy || !email.trim()}
                    onPress={() => {
                      void run(async () => {
                        await account.resendVerification(email);
                        setMessage("If your account needs verification, a new link is on its way.");
                      });
                    }}
                  />
                ) : null}
              </>
            ) : null}
          </>
        )}
        {message ? (
          <Text accessibilityLiveRegion="polite" className="text-base text-foreground-muted">
            {message}
          </Text>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-base text-danger-foreground">
            {error}
          </Text>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
