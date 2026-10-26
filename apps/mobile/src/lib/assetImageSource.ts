import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import type { ImageSource } from "expo-image";

/** Cache immutable attachments by id; signed URLs change on each mint and reconnect. */
export function assetImageSource(
  environmentId: EnvironmentId,
  resource: AssetResource,
  uri: string,
): ImageSource {
  return resource._tag === "attachment"
    ? {
        uri,
        cacheKey: `mines-attachment:${JSON.stringify([environmentId, resource.attachmentId])}`,
      }
    : { uri };
}
