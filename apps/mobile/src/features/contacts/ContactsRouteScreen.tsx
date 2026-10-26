import { incomingContactInvitations } from "@t3tools/shared/minesContacts";
import type { ContactProfile } from "@t3tools/contracts/contacts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { Button } from "../../components/ui/Button";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useMinesAccount } from "../cloud/MinesAccountProvider";
import { ContactAvatar } from "./ContactAvatar";
import { pickContactPhoto } from "./pickContactPhoto";
import { useContacts } from "./useContacts";

export function ContactsAccountNotice({
  configured,
  title = "Contacts",
}: {
  readonly configured: boolean;
  readonly title?: string;
}) {
  const navigation = useNavigation();
  return (
    <View className="gap-4 p-6">
      <Text className="text-xl font-mines-bold">{title}</Text>
      <Text className="text-foreground-muted">
        {configured
          ? "Sign in to your mines account to add friends and receive group invitations."
          : "The mines account service is unavailable on this build."}
      </Text>
      {configured ? (
        <Button
          label="Sign in"
          onPress={() => navigation.dispatch(StackActions.push("SettingsAuth"))}
        />
      ) : null}
    </View>
  );
}

export function ContactsRouteScreen() {
  const contacts = useContacts();
  return <ContactsContent key={contacts.accountId ?? "signed-out"} contacts={contacts} />;
}

function ContactsContent({ contacts }: { readonly contacts: ReturnType<typeof useContacts> }) {
  const bottom = useWorkspaceTabs()?.bottomClearance ?? 24;
  const [friendId, setFriendId] = useState("");
  const data = contacts.data;
  if (!contacts.isSignedIn || !contacts.configured)
    return <ContactsAccountNotice configured={contacts.configured} />;
  const invitations = data ? incomingContactInvitations(data) : [];
  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerClassName="gap-6 p-4"
      contentContainerStyle={{ paddingBottom: bottom + 24 }}
      refreshControl={
        <RefreshControl
          refreshing={contacts.pending && data !== null}
          onRefresh={() => void contacts.refresh()}
        />
      }
    >
      <View className="flex-row items-center justify-between gap-3">
        <Text accessibilityRole="header" className="text-xl font-mines-bold">
          Contacts
        </Text>
        <Menu
          actions={
            invitations.length
              ? invitations.map((invitation) => ({
                  id: invitation.id,
                  title: `${invitation.inviter.displayName} · ${invitation.groupName}`,
                  image: "person.2",
                  subactions: [
                    {
                      id: `accept:${invitation.id}`,
                      title: "Accept",
                      image: "checkmark",
                      attributes: { disabled: contacts.pending },
                    },
                    {
                      id: `decline:${invitation.id}`,
                      title: "Decline",
                      image: "xmark",
                      attributes: { disabled: contacts.pending },
                    },
                  ],
                }))
              : [{ id: "empty", title: "No pending invitations", attributes: { disabled: true } }]
          }
          onPressAction={({ nativeEvent }) => {
            const action = nativeEvent.event;
            if (action.startsWith("accept:"))
              void contacts.run((client) => client.respond(action.slice(7), "accept"));
            else if (action.startsWith("decline:"))
              void contacts.run((client) => client.respond(action.slice(8), "decline"));
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Group invitations, ${invitations.length} pending`}
            className="flex-row items-center gap-2 rounded-full bg-subtle px-3 py-2"
          >
            <SymbolView name="bell.badge" size={18} tintColorClassName="accent-icon" />
            <Text>
              {invitations.length ? `Invitations · ${invitations.length}` : "Invitations"}
            </Text>
          </Pressable>
        </Menu>
      </View>
      {contacts.error ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {contacts.error}
        </Text>
      ) : null}
      {!data ? (
        <AppActivityIndicator />
      ) : (
        <>
          <ProfileEditor
            key={`${contacts.accountId}:${data.profile.friendId}`}
            profile={data.profile}
            contacts={contacts}
          />
          <View className="gap-3 rounded-2xl border border-border p-4">
            <Text className="font-mines-bold">Add by friend ID</Text>
            <AppTextInput
              accessibilityLabel="Friend ID"
              value={friendId}
              onChangeText={setFriendId}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="mines-…"
              maxLength={80}
            />
            <Button
              label="Add contact"
              icon="person.badge.plus"
              disabled={contacts.pending || !friendId.trim()}
              onPress={() => {
                void contacts
                  .run((client) => client.addContact(friendId))
                  .then((saved) => {
                    if (saved) setFriendId("");
                  });
              }}
            />
          </View>
          <View className="gap-3">
            <Text className="font-mines-bold">Your contacts</Text>
            {data.contacts.length === 0 ? (
              <Text className="text-foreground-muted">Add a friend using their ID.</Text>
            ) : (
              data.contacts.map((profile) => (
                <View
                  key={profile.friendId}
                  className="flex-row items-center gap-3 rounded-2xl bg-subtle p-3"
                >
                  <ContactAvatar profile={profile} />
                  <View className="min-w-0 flex-1 gap-1">
                    <Text className="font-mines-medium" numberOfLines={1}>
                      {profile.displayName}
                    </Text>
                    <Text selectable className="text-xs text-foreground-muted">
                      {profile.friendId}
                    </Text>
                  </View>
                  <Menu
                    actions={[
                      {
                        id: "remove",
                        title: "Remove contact",
                        image: "person.badge.minus",
                        attributes: { destructive: true, disabled: contacts.pending },
                      },
                    ]}
                    onPressAction={({ nativeEvent }) => {
                      if (nativeEvent.event === "remove")
                        void contacts.run((client) => client.removeContact(profile.friendId));
                    }}
                  >
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Manage ${profile.displayName}`}
                      className="p-3"
                    >
                      <SymbolView name="ellipsis" size={18} tintColorClassName="accent-icon" />
                    </Pressable>
                  </Menu>
                </View>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

function ProfileEditor({
  profile,
  contacts,
}: {
  readonly profile: ContactProfile;
  readonly contacts: ReturnType<typeof useContacts>;
}) {
  const { refreshSession } = useMinesAccount();
  const [editedName, setEditedName] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const name = editedName ?? profile.displayName;
  const saveProfile = async (avatar: string | null) => {
    const saved = await contacts.run((client) =>
      client.updateProfile({ displayName: name.trim(), avatar }),
    );
    if (saved) await refreshSession();
  };
  const changePhoto = async () => {
    setPhotoError(null);
    try {
      const avatar = await pickContactPhoto();
      if (avatar !== null) await saveProfile(avatar);
    } catch (cause) {
      setPhotoError(
        cause instanceof Error ? cause.message : "The profile photo could not be opened.",
      );
    }
  };
  return (
    <View className="gap-4 rounded-2xl border border-border p-4">
      <View className="flex-row items-center gap-4">
        <Menu
          actions={[
            {
              id: "photo",
              title: "Choose photo",
              image: "photo",
              attributes: { disabled: contacts.pending },
            },
            ...(profile.avatar
              ? [
                  {
                    id: "remove",
                    title: "Remove photo",
                    image: "trash",
                    attributes: { disabled: contacts.pending },
                  },
                ]
              : []),
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "photo") void changePhoto();
            if (nativeEvent.event === "remove")
              void saveProfile(null).catch((cause: unknown) =>
                setPhotoError(
                  cause instanceof Error
                    ? cause.message
                    : "The account profile could not be refreshed.",
                ),
              );
          }}
        >
          <Pressable accessibilityRole="button" accessibilityLabel="Change profile photo">
            <ContactAvatar profile={profile} size={64} />
          </Pressable>
        </Menu>
        <View className="min-w-0 flex-1 gap-1">
          <Text className="font-mines-bold">Your friend ID</Text>
          <Text selectable className="text-sm text-foreground-muted">
            {profile.friendId}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy friend ID"
            onPress={() => copyTextWithHaptic(profile.friendId, { target: "friend ID" })}
            className="self-start py-2"
          >
            <Text className="text-primary-text">Copy ID</Text>
          </Pressable>
        </View>
      </View>
      <AppTextInput
        accessibilityLabel="Profile display name"
        value={name}
        onChangeText={setEditedName}
        maxLength={100}
      />
      <Button
        label="Save profile"
        disabled={contacts.pending || !name.trim() || name.trim() === profile.displayName}
        onPress={() =>
          void saveProfile(profile.avatar).catch((cause: unknown) =>
            setPhotoError(
              cause instanceof Error
                ? cause.message
                : "The account profile could not be refreshed.",
            ),
          )
        }
      />
      {photoError ? (
        <Text accessibilityRole="alert" className="text-danger-foreground">
          {photoError}
        </Text>
      ) : null}
    </View>
  );
}
