import type { GroupMember, GroupSnapshot } from "@t3tools/contracts";
import { BotIcon, ChevronRightIcon, UsersIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { groupActivity } from "@t3tools/client-runtime/group-chat";

export function GroupConversationSidebar({
  snapshot,
  users,
  renderMineActions,
  onMention,
  children,
}: {
  readonly snapshot: GroupSnapshot | null;
  readonly users: ReactNode;
  readonly renderMineActions?: (member: GroupMember) => ReactNode;
  readonly onMention: (alias: string) => void;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const active = groupActivity(snapshot?.members ?? [], snapshot?.rounds ?? []);
  const mention = (alias: string) => {
    setOpen(false);
    onMention(alias);
  };
  return (
    <>
      <div className="absolute right-3 top-3 z-10 lg:hidden">
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Show group participants"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <UsersIcon />
        </Button>
      </div>
      <aside
        aria-label="Group participants"
        className={`${open ? "flex" : "hidden"} absolute inset-y-0 right-0 z-20 w-72 max-w-[85%] shrink-0 flex-col overflow-y-auto border-l border-border bg-background px-4 py-5 lg:static lg:flex lg:max-w-none`}
      >
        <div className="mb-5 flex items-center justify-between lg:hidden">
          <h2 className="text-sm font-medium">Participants</h2>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Close group participants"
            onClick={() => setOpen(false)}
          >
            <XIcon />
          </Button>
        </div>
        <section className="mb-7" aria-label="Activity">
          <h2 className="mb-3 text-xs font-medium text-muted-foreground">
            Activity · {active.length}
          </h2>
          <div className="space-y-2">
            {active.map(({ member, startedAt }) => (
              <div
                key={member.id}
                className="rounded-xl border border-border bg-muted/30 px-3 py-3"
              >
                <p className="truncate text-sm font-medium">{member.alias}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {member.modelSelection.model}
                </p>
                <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="size-1.5 rounded-full bg-success" />
                  {startedAt ? (
                    <span>
                      Working since{" "}
                      <time dateTime={startedAt}>
                        {new Date(startedAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </span>
                  ) : (
                    "Working"
                  )}
                </p>
              </div>
            ))}
            {active.length === 0 ? (
              <p className="text-xs text-muted-foreground">No mines working right now.</p>
            ) : null}
          </div>
        </section>
        <section className="mb-7" aria-label="Users">
          <h2 className="mb-3 text-xs font-medium text-muted-foreground">Users</h2>
          <div className="space-y-3">{users}</div>
        </section>
        <section aria-label="Mines">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-xs font-medium text-muted-foreground">
              Mines · {snapshot?.members.length ?? 0}
            </h2>
            <Button size="xs" variant="ghost-muted" onClick={() => mention("everyone")}>
              @everyone
            </Button>
          </div>
          <div className="space-y-1">
            {snapshot?.members.map((member) => (
              <div key={member.id} className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Mention ${member.alias}`}
                  onClick={() => mention(member.alias)}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <BotIcon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{member.alias}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {member.modelSelection.model}
                    </span>
                  </span>
                  <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
                </button>
                {renderMineActions?.(member)}
              </div>
            ))}
          </div>
          {children ? <div className="mt-4">{children}</div> : null}
        </section>
      </aside>
    </>
  );
}
