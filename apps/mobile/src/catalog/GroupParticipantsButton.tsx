import { Pressable, View } from "react-native";
import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";

export function GroupParticipantsButton({
  onPress,
  disabled,
}: {
  readonly onPress: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add participants"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      className="min-h-12 flex-row items-center justify-center gap-2 rounded-full bg-secondary px-4 active:opacity-70 disabled:opacity-40"
    >
      <View className="h-6 w-7">
        <SymbolView name="person.2" size={22} tintColorClassName="accent-secondary-foreground" />
        <View className="absolute -bottom-0.5 -right-0.5 rounded-full bg-secondary">
          <SymbolView name="plus" size={11} tintColorClassName="accent-secondary-foreground" />
        </View>
      </View>
      <Text className="font-mines-medium text-secondary-foreground">Add participants</Text>
    </Pressable>
  );
}
