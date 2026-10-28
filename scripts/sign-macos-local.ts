import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default async function sign(options: SignOptions): Promise<void> {
  const identity = (
    await Effect.runPromise(Config.String("MINES_DESKTOP_LOCAL_SIGN_IDENTITY"))
  ).trim();
  if (!/^[A-F0-9]{40}$/u.test(identity))
    throw new Error("Local signing requires a pinned certificate SHA-1.");
  await signApplication({
    ...options,
    identity,
    identityValidation: false,
    type: "development",
    batchCodesignCalls: true,
  });
}
