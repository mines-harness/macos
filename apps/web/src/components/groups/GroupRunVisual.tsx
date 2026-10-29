import type { EnvironmentId, GroupId, TurnItemId } from "@t3tools/contracts";
import type { SharedGroupGetInput } from "@t3tools/contracts/sharedGroups";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import { useEnvironmentQuery } from "../../state/query";
import { groupRunAsset } from "../../state/groups";
import { sharedGroupRunAsset } from "../../state/sharedGroups";
import { HtmlRenderFrame } from "../chat/HtmlRenderFrame";
import { ChatMarkdownAssetImage } from "../chat/ChatMarkdownMedia";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";

export interface GroupRunVisualScope {
  readonly environmentId: EnvironmentId;
  readonly groupId: GroupId;
  readonly sharedAddress?: SharedGroupGetInput;
  readonly deliveryId: string;
  readonly itemId: TurnItemId;
  readonly index?: number;
}

function useGroupRunAsset(scope: GroupRunVisualScope, kind: "html" | "image") {
  const input = {
    deliveryId: scope.deliveryId,
    itemId: scope.itemId,
    kind,
    ...(scope.index !== undefined ? { index: scope.index } : {}),
  };
  return useEnvironmentQuery(
    scope.sharedAddress
      ? sharedGroupRunAsset({
          environmentId: scope.environmentId,
          input: { ...scope.sharedAddress, ...input },
        })
      : groupRunAsset({
          environmentId: scope.environmentId,
          input: { groupId: scope.groupId, ...input },
        }),
  );
}

export function GroupRunHtmlRender({
  reference,
  ...scope
}: GroupRunVisualScope & { readonly reference: HtmlRenderReference }) {
  const asset = useGroupRunAsset(scope, "html");
  if (asset.isPending || !asset.data)
    return (
      <p role={asset.error ? "alert" : "status"} className="py-2 text-xs text-muted-foreground">
        {asset.error ?? "Loading visual…"}
      </p>
    );
  return (
    <HtmlRenderFrame
      environmentId={scope.environmentId}
      htmlRender={{ ...reference, attachmentId: asset.data.id }}
      threadRef={undefined}
    />
  );
}

export function GroupRunImage({
  onImageExpand,
  ...scope
}: GroupRunVisualScope & { readonly onImageExpand: (preview: ExpandedImagePreview) => void }) {
  const asset = useGroupRunAsset(scope, "image");
  if (asset.isPending || !asset.data)
    return (
      <p role={asset.error ? "alert" : "status"} className="text-xs text-muted-foreground">
        {asset.error ?? "Loading image…"}
      </p>
    );
  return (
    <ChatMarkdownAssetImage
      environmentId={scope.environmentId}
      resource={{
        _tag: "attachment",
        attachmentId: asset.data.id,
        fileName: asset.data.name,
        mimeType: asset.data.mimeType,
      }}
      alt={asset.data.name}
      maxHeightRem={16}
      onImageExpand={onImageExpand}
    />
  );
}
