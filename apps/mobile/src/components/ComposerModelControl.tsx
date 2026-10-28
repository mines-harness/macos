import type { ModelSelection, ProviderDriverKind } from "@t3tools/contracts";
import {
  getPromptControlledTraits,
  REASONING_SELECT_DESCRIPTOR_IDS,
} from "@t3tools/client-runtime/model-traits";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { View } from "react-native";
import type { ModelOption } from "../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../lib/providerOptions";
import { MOBILE_TYPOGRAPHY } from "../lib/typography";
import { SymbolView } from "./ui/AppSymbol";
import { useAndroidControlSizing } from "./ui/useAndroidControlSizing";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon } from "./ProviderIcon";

export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly provider: ProviderDriverKind | undefined;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  readonly onPress: () => void;
  readonly onPressReasoning?: (descriptorId: string) => void;
}) {
  const { scale } = useAndroidControlSizing();
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: props.modelOption?.capabilities,
    selections: props.selection?.options,
  });
  const promptTraits = getPromptControlledTraits(descriptors, props.prompt);
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const reasoningDescriptor = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" && REASONING_SELECT_DESCRIPTOR_IDS.has(descriptor.id),
  );
  const reasoningLabel =
    reasoningDescriptor &&
    promptTraits.ultrathinkPromptControlled &&
    reasoningDescriptor.id === promptTraits.primarySelectDescriptor?.id
      ? "Ultrathink"
      : getProviderOptionCurrentLabel(
          reasoningDescriptor,
          props.selection,
          props.reportedSelection,
        );
  const serviceTier = descriptors.find((descriptor) => descriptor.id === "serviceTier");
  const fastMode = descriptors.find((descriptor) => descriptor.id === "fastMode");
  const speedLabel =
    props.provider === "codex" && serviceTier
      ? getProviderOptionCurrentLabel(serviceTier, props.selection, props.reportedSelection)
      : getProviderOptionCurrentValue(fastMode, props.selection, props.reportedSelection) === true
        ? "Fast"
        : undefined;
  const speedIconCount = speedLabel === "Ultrafast" ? 2 : speedLabel === "Fast" ? 1 : 0;
  const speedIconSize = Math.round(MOBILE_TYPOGRAPHY.caption.fontSize * scale);
  const speedIconOffset = Math.round(speedIconSize / 3);
  return (
    <View className="min-w-0 shrink flex-row items-center">
      <View className="min-w-0 shrink">
        <ComposerInlineControl
          accessibilityLabel={["Model", label, badge?.showBadge ? badge.displayName : null]
            .filter(Boolean)
            .join(", ")}
          size={props.size}
          disabled={props.disabled}
          emphasized
          renderIcon={(size) =>
            badge?.showBadge ? (
              <ProviderInstanceIcon
                iconUrl={props.modelOption?.providerIconUrl}
                provider={props.modelOption?.providerDriver}
                displayName={badge.displayName}
                accentColor={badge.accentColor}
                showBadge
                surfaceColor={props.surfaceColor}
                size={size}
              />
            ) : (
              <ProviderIcon
                iconUrl={props.modelOption?.providerIconUrl}
                provider={props.modelOption?.providerDriver}
                size={size}
              />
            )
          }
          label={label}
          detail={speedIconCount > 0 ? speedLabel : undefined}
          iconOnly={props.iconOnly}
          detailPrefix={
            speedIconCount > 0 ? (
              <View
                style={{
                  width: speedIconSize + (speedIconCount === 2 ? speedIconOffset : 0),
                  height: speedIconSize,
                }}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              >
                <SymbolView
                  name={{ ios: "bolt.fill", android: "bolt" }}
                  size={speedIconSize}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                  style={{ position: "absolute", left: 0, top: 0 }}
                />
                {speedIconCount === 2 ? (
                  <SymbolView
                    name={{ ios: "bolt.fill", android: "bolt" }}
                    size={speedIconSize}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                    style={{ position: "absolute", left: speedIconOffset, top: 0 }}
                  />
                ) : null}
              </View>
            ) : undefined
          }
          maxWidth="100%"
          onPress={props.onPress}
        />
      </View>
      {reasoningDescriptor ? (
        <ComposerInlineControl
          accessibilityLabel={`Reasoning effort, ${reasoningLabel || "Default"}`}
          size={props.size}
          disabled={props.disabled}
          icon="brain"
          label={reasoningLabel || "Reasoning"}
          iconOnly={props.iconOnly}
          onPress={() => {
            if (props.onPressReasoning) props.onPressReasoning(reasoningDescriptor.id);
            else props.onPress();
          }}
        />
      ) : null}
    </View>
  );
}
