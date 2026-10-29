import type { ConversationActivity, ConversationActivityKind } from "@t3tools/contracts";

import { useActiveConversationActivity } from "../../hooks/useConversationActivity";
import styles from "./conversationActivity.module.css";

function ConversationActivityGlyph({ kind }: { readonly kind: ConversationActivityKind }) {
  if (kind === "idle") return null;
  return (
    <span aria-hidden className={`${styles.glyph} ${styles[kind]}`}>
      {Array.from({ length: kind === "voice" ? 5 : 3 }, (_, index) => (
        <i key={index} />
      ))}
    </span>
  );
}

export function ConversationActivityIndicator({
  activity,
  name,
  includeName = true,
}: {
  readonly activity: ConversationActivity | null | undefined;
  readonly name: string;
  readonly includeName?: boolean;
}) {
  const kind = useActiveConversationActivity(activity);
  if (kind === "idle") return null;
  return (
    <span
      role="status"
      aria-label={`${name} ${kind === "voice" ? "is singing" : "is typing"}`}
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
    >
      <ConversationActivityGlyph kind={kind} />
      <span>
        {includeName ? (
          <>
            <strong className="font-semibold">{name}</strong>{" "}
          </>
        ) : null}
        {kind === "voice" ? "is singing..." : "is typing..."}
      </span>
    </span>
  );
}

export function ConversationActivityBubble({
  kind,
  name = "The host",
}: {
  readonly kind: ConversationActivityKind;
  readonly name?: string;
}) {
  if (kind === "idle") return null;
  return (
    <div
      className={styles.bubble}
      role="status"
      aria-label={`${name} ${kind === "voice" ? "is speaking" : "is typing"}`}
    >
      <span aria-hidden className={styles.body} />
      <span aria-hidden className={styles.edge} />
      <ConversationActivityGlyph kind={kind} />
    </div>
  );
}
