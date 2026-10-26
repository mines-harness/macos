import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Haptics from "expo-haptics";
import { useIsFocused, useRoute, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { decodePeerPairing } from "@t3tools/shared/minesPeerPairing";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { cn } from "../../lib/cn";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { AppText as Text } from "../../components/ui/AppText";
import { FrostedCutout } from "../../components/ui/FrostedCutout";
import { SymbolView } from "../../components/ui/AppSymbol";
import { PeerPairingSection } from "./PeerPairingSection";

type ConnectionsNewRouteParams = {
  readonly mode?: string;
  readonly pairingUrl?: string;
  readonly autoConnect?: string;
  readonly routeFor?: EnvironmentId;
};

export function ConnectionsNewRouteScreen(
  _props: StaticScreenProps<ConnectionsNewRouteParams | undefined>,
) {
  const routeName = useRoute().name;
  const insets = useSafeAreaInsets();
  const [peerCode, setPeerCode] = useState("");
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const screenFocused = useIsFocused();
  const [scannerLocked, setScannerLocked] = useState(false);
  const [scanComplete, setScanComplete] = useState(false);

  const handleScanPress = async () => {
    const permission = await requestCameraPermission();
    if (permission.granted) {
      setScanComplete(false);
      return;
    }
    if (permission.canAskAgain) return;
    Dialog.alert(
      "Camera access needed",
      "Open Settings to allow scanning your computer's pairing QR.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Open Settings", onPress: () => void Linking.openSettings() },
      ],
    );
  };

  const handleQrScan = ({ data }: { readonly data: string }) => {
    if (scannerLocked) return;
    setScannerLocked(true);
    try {
      decodePeerPairing(data, Date.now() / 1000);
      setPeerCode(data);
      setScanComplete(true);
      setScannerLocked(false);
    } catch (error) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Dialog.alert(
        "Invalid QR code",
        error instanceof Error ? error.message : "Use a mines peer pairing code.",
      );
      setTimeout(() => setScannerLocked(false), 600);
    }
  };

  return (
    <SettingsScreen formSheet={routeName === "ConnectionsNew"} title="Pair a device">
      <ScrollView
        nestedScrollEnabled
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentInset={{ bottom: Math.max(insets.bottom, 18) + 18 }}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 4 }}
      >
        <View collapsable={false} className="gap-6.5">
          <PairingScanCard
            cameraActive={cameraPermission?.granted === true && screenFocused && !scanComplete}
            onScan={handleQrScan}
            onScanPress={() => {
              void handleScanPress();
            }}
          />
          <PeerPairingSection key={peerCode} scannedCode={peerCode} />
        </View>
      </ScrollView>
    </SettingsScreen>
  );
}

const SCAN_CARD_HEIGHT = 250;
const SCAN_RETICLE_SIZE = 150;
const SCAN_RETICLE_TOP = 36;
const SCAN_RETICLE_RADIUS = 28;

function PairingScanCard(props: {
  readonly cameraActive: boolean;
  readonly onScan: (result: { readonly data: string }) => void;
  readonly onScanPress: () => void;
}) {
  const light = useAppearancePreferences().themeAppearance === "light";
  return (
    <Pressable
      accessibilityRole={props.cameraActive ? undefined : "button"}
      accessibilityLabel={props.cameraActive ? undefined : "Scan QR code"}
      disabled={props.cameraActive}
      onPress={props.onScanPress}
      className={cn(
        "overflow-hidden rounded-[26px] border-continuous",
        light ? "bg-white" : "bg-black",
      )}
      style={{ height: SCAN_CARD_HEIGHT }}
    >
      <Svg accessibilityElementsHidden height="100%" style={StyleSheet.absoluteFill} width="100%">
        <Defs>
          <RadialGradient id="pairing-scan-backdrop" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={light ? "#f4f4f5" : "#2e2e2e"} />
            <Stop offset="100%" stopColor={light ? "#d9d9dc" : "#0e0e0e"} />
          </RadialGradient>
        </Defs>
        <Rect fill="url(#pairing-scan-backdrop)" height="100%" width="100%" />
      </Svg>

      {props.cameraActive ? (
        <>
          <CameraView
            active
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={props.onScan}
            style={StyleSheet.absoluteFill}
          />
          <FrostedCutout
            cutoutTop={SCAN_RETICLE_TOP}
            cutoutWidth={SCAN_RETICLE_SIZE}
            cutoutHeight={SCAN_RETICLE_SIZE}
            cutoutRadius={SCAN_RETICLE_RADIUS}
            appearance={light ? "light" : "dark"}
          />
        </>
      ) : null}

      <View
        pointerEvents="none"
        className="absolute inset-x-0 items-center gap-3.5"
        style={{ top: SCAN_RETICLE_TOP }}
      >
        <View
          className={cn(
            "items-center justify-center gap-2 border-continuous border-[3px]",
            light ? "border-black/70" : "border-white/80",
          )}
          style={{
            borderRadius: SCAN_RETICLE_RADIUS,
            height: SCAN_RETICLE_SIZE,
            width: SCAN_RETICLE_SIZE,
          }}
        >
          {props.cameraActive ? null : (
            <>
              <SymbolView
                name="qrcode.viewfinder"
                size={44}
                tintColorClassName={light ? "accent-black/60" : "accent-white/70"}
                type="monochrome"
                weight="light"
              />
              <Text
                className={cn(
                  "font-mines-medium text-sm",
                  light ? "text-black/70" : "text-white/80",
                )}
              >
                Tap to scan
              </Text>
            </>
          )}
        </View>
        <Text className={cn("text-center text-sm", light ? "text-black/70" : "text-white/80")}>
          Scan the QR from mines Settings → Connections
        </Text>
      </View>
    </Pressable>
  );
}
