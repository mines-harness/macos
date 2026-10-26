import type { ColorValue } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText } from "./ui/AppText";

export function MinesWordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
  readonly allowFontScaling?: boolean;
}) {
  const themedColor = useResolveClassNames(props.colorClassName ?? "accent-icon").accentColor;

  return (
    <AppText
      accessibilityLabel="mines"
      allowFontScaling={props.allowFontScaling ?? false}
      className="font-mines-bold"
      style={{
        color: props.color ?? themedColor,
        fontSize: props.height * 1.4,
        lineHeight: props.height * 1.6,
        letterSpacing: -props.height * 0.03,
      }}
    >
      mines
    </AppText>
  );
}
