import type { ContactProfile } from "@t3tools/contracts/contacts";
import { Image } from "expo-image";
import { View } from "react-native";
import { AppText } from "../../components/ui/AppText";

export function ContactAvatar({
  profile,
  size = 44,
}: {
  readonly profile: ContactProfile;
  readonly size?: number;
}) {
  return profile.avatar ? (
    <Image
      source={{ uri: profile.avatar }}
      accessibilityLabel={`${profile.displayName}'s profile photo`}
      contentFit="cover"
      style={{ width: size, height: size, borderRadius: size / 2 }}
    />
  ) : (
    <View
      className="items-center justify-center bg-subtle-strong"
      style={{ width: size, height: size, borderRadius: size / 2 }}
    >
      <AppText className="font-mines-bold" style={{ fontSize: size * 0.38 }}>
        {profile.displayName.slice(0, 1).toLocaleUpperCase()}
      </AppText>
    </View>
  );
}
