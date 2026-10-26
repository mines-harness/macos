import { CatalogRpcError } from "@t3tools/contracts/catalogRpc";
import { getPeerAccount } from "@t3tools/shared/minesPeerSignaling";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { controlUrlConfig } from "../cloud/publicConfig.ts";

export class CatalogIdentityVerifier extends Context.Service<
  CatalogIdentityVerifier,
  { readonly verify: (token: string) => Effect.Effect<string, CatalogRpcError> }
>()("mines/catalog/CatalogIdentityVerifier") {}

export function createCatalogIdentityVerifier(controlUrl: string, fetcher?: typeof fetch) {
  return async (token: string) => {
    const accountId = await getPeerAccount({
      controlUrl,
      bearerToken: async () => token,
      ...(fetcher ? { fetch: fetcher } : {}),
    });
    if (!accountId || accountId.length > 200 || accountId === "local-device")
      throw new Error("Invalid mines account.");
    return accountId;
  };
}

export const layer = Layer.effect(
  CatalogIdentityVerifier,
  Effect.gen(function* () {
    const controlUrl = yield* controlUrlConfig.pipe(Effect.orElseSucceed(() => ""));
    const verify = createCatalogIdentityVerifier(controlUrl);
    return CatalogIdentityVerifier.of({
      verify: Effect.fn("CatalogIdentityVerifier.verify")((token) =>
        Effect.tryPromise({
          try: () => verify(token),
          catch: () =>
            new CatalogRpcError({
              message:
                "This computer could not verify your mines account. Check its mines sign-in configuration and sign in again.",
            }),
        }),
      ),
    });
  }),
);
