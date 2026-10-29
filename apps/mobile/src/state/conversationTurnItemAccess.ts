import type {
  AssetResource,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import type { AsyncResult, Atom } from "effect/reactivity";
import { createContext, type ReactNode } from "react";

export const ConversationTurnItemAccess = createContext<{
  readonly itemQuery: (
    row: OrchestrationV2ProjectedTurnItem,
  ) => Atom.Atom<AsyncResult.AsyncResult<OrchestrationV2GetTurnItemResult, unknown>>;
  readonly loadEarlierBody: (row: OrchestrationV2ProjectedTurnItem) => Promise<void>;
  readonly renderOutputImage?: (
    resource: Extract<AssetResource, { readonly _tag: "tool-output-image" }>,
  ) => ReactNode;
} | null>(null);
