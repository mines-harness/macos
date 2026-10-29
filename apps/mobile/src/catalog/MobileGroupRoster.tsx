import type { ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import type { ContactProfile } from "@t3tools/contracts/contacts";
import type { GroupSnapshot } from "@t3tools/contracts/groupChat";
import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { ContactAvatar } from "../features/contacts/ContactAvatar";
import { groupActivity } from "@t3tools/client-runtime/group-chat";

export function MobileGroupRoster({
  snapshot,
  users,
  onClose,
  onMention,
  onRemoveUser,
  removeUserIds,
  disabled,
  children,
}: {
  readonly snapshot: GroupSnapshot | null | undefined;
  readonly users?: readonly ContactProfile[];
  readonly onClose: () => void;
  readonly onMention: (alias: string) => void;
  readonly onRemoveUser?: (user: ContactProfile) => void;
  readonly removeUserIds?: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly children?: ReactNode;
}) {
  const activity = groupActivity(snapshot?.members ?? [], snapshot?.rounds ?? []);
  return (
    <View className="absolute inset-0 flex-row justify-end bg-black/30">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close participants"
        onPress={onClose}
        className="absolute inset-0"
      />
      <View
        accessibilityLabel="Conversation participants"
        className="h-full border-l border-border bg-background"
        style={{ width: "100%", maxWidth: 320 }}
      >
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <Text className="font-mines-bold">Participants</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close participants"
            onPress={onClose}
            className="p-2"
          >
            <SymbolView name="xmark" size={16} tintColorClassName="accent-icon" />
          </Pressable>
        </View>
        <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, gap: 24 }}>
          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="text-xs font-mines-bold text-foreground-muted"
            >
              Activity · {activity.length}
            </Text>
            {activity.length ? (
              activity.map(({ member, startedAt }) => (
                <View key={member.id} className="gap-1 rounded-xl bg-muted p-3">
                  <View className="flex-row items-center gap-2">
                    <View className="h-2 w-2 rounded-full bg-primary" />
                    <Text className="flex-1 font-mines-medium" numberOfLines={1}>
                      {member.alias}
                    </Text>
                  </View>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {member.modelSelection.model}
                  </Text>
                  <Text className="text-xs text-foreground-muted">
                    {startedAt
                      ? `Working since ${new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                      : "Working"}
                  </Text>
                </View>
              ))
            ) : (
              <Text className="text-sm text-foreground-muted">No mines working right now.</Text>
            )}
          </View>
          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="text-xs font-mines-bold text-foreground-muted"
            >
              Users · {users?.length ?? 1}
            </Text>
            {users ? (
              users.map((user) => (
                <View key={user.friendId} className="flex-row items-center gap-3">
                  <ContactAvatar profile={user} size={32} />
                  <Text className="min-w-0 flex-1" numberOfLines={1}>
                    {user.displayName}
                  </Text>
                  {onRemoveUser && removeUserIds?.has(user.friendId) ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${user.displayName} from group`}
                      disabled={disabled}
                      onPress={() => onRemoveUser(user)}
                      className="p-2"
                    >
                      <SymbolView
                        name="person.fill.xmark"
                        size={18}
                        tintColorClassName="accent-icon-muted"
                      />
                    </Pressable>
                  ) : null}
                </View>
              ))
            ) : (
              <View className="flex-row items-center gap-3">
                <View className="h-8 w-8 items-center justify-center rounded-full bg-muted">
                  <SymbolView
                    name="person.crop.circle"
                    size={18}
                    tintColorClassName="accent-icon"
                  />
                </View>
                <Text>You</Text>
              </View>
            )}
          </View>
          <View className="gap-3">
            <Text
              accessibilityRole="header"
              className="text-xs font-mines-bold text-foreground-muted"
            >
              Mines · {snapshot?.members.length ?? 0}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => onMention("everyone")}
              className="flex-row items-center gap-3 py-1"
            >
              <SymbolView name="person.2" size={22} tintColorClassName="accent-icon-muted" />
              <Text>Everyone</Text>
            </Pressable>
            {snapshot?.members.map((member) => (
              <Pressable
                key={member.id}
                accessibilityRole="button"
                accessibilityLabel={`Mention ${member.alias}`}
                disabled={disabled}
                onPress={() => onMention(member.alias)}
                className="flex-row items-center gap-3 py-1"
              >
                <SymbolView name="brain" size={22} tintColorClassName="accent-icon-muted" />
                <View className="min-w-0 flex-1 gap-1">
                  <Text numberOfLines={1}>{member.alias}</Text>
                  <Text className="text-xs text-foreground-muted" numberOfLines={1}>
                    {member.modelSelection.model}
                  </Text>
                </View>
              </Pressable>
            ))}
            {!snapshot?.members.length ? (
              <Text className="text-sm text-foreground-muted">No mines have joined yet.</Text>
            ) : null}
          </View>
          {children}
        </ScrollView>
      </View>
    </View>
  );
}
