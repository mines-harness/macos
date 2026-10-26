import { expect, it } from "vite-plus/test";

import { providerAccountMessage } from "./providerAccountMessage";

it("keeps the ChatGPT consent explanation after the sign-in flow returns to idle", () => {
  const message =
    "Signed in with ChatGPT, but token sharing is disabled. Enable sharing to continue.";
  expect(providerAccountMessage({ message }, { phase: "idle", message: null }, false)).toBe(
    message,
  );
});

it("shows a failed model check even when the ChatGPT identity is still authenticated", () => {
  const message = "Could not check Codex right now. Retry, or reconnect in provider settings.";
  expect(providerAccountMessage({ message }, { phase: "succeeded", message: null }, true)).toBe(
    message,
  );
});

it("shows current sign-in progress before a previous provider failure", () => {
  expect(
    providerAccountMessage(
      { message: "Previous check failed." },
      { phase: "verifying", message: "Verifying your ChatGPT account." },
      false,
    ),
  ).toBe("Verifying your ChatGPT account.");
});

it("confirms a signed-in account when there is no provider warning", () => {
  expect(providerAccountMessage({}, { phase: "idle", message: null }, true)).toBe("Signed in.");
  expect(providerAccountMessage({}, undefined, false)).toBeNull();
});
