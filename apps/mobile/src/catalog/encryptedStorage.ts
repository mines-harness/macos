import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  AESEncryptionKey,
  AESSealedData,
  aesDecryptAsync,
  aesEncryptAsync,
  CryptoDigestAlgorithm,
  digestStringAsync,
} from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const stores = new Map<string, Promise<MobilePrivateStore>>();

export interface MobilePrivateStore {
  read(recordId: string): Promise<Uint8Array | null>;
  write(recordId: string, bytes: Uint8Array): Promise<void>;
  remove(recordId: string): Promise<void>;
  clear(): Promise<void>;
}

export function openMobilePrivateStore(accountId: string): Promise<MobilePrivateStore> {
  const existing = stores.get(accountId);
  if (existing) return existing;
  const opening = createStore(accountId);
  stores.set(accountId, opening);
  void opening.catch(() => stores.delete(accountId));
  return opening;
}

async function createStore(accountId: string): Promise<MobilePrivateStore> {
  const scope = await digestStringAsync(CryptoDigestAlgorithm.SHA256, accountId);
  const keyId = `mines.private.key.${scope}`;
  const prefix = `mines.private.v1:${scope}:`;
  let encodedKey = await SecureStore.getItemAsync(keyId);
  if (encodedKey === null) {
    if ((await AsyncStorage.getAllKeys()).some((name) => name.startsWith(prefix)))
      throw new Error(
        "This phone’s private cache key is unavailable. Reconnect and reset its local cache to recover.",
      );
    const key = await AESEncryptionKey.generate();
    encodedKey = await key.encoded("base64");
    await SecureStore.setItemAsync(keyId, encodedKey, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  const key = await AESEncryptionKey.import(encodedKey, "base64");
  const aad = (recordId: string) => new TextEncoder().encode(`${prefix}${recordId}`);
  return {
    async read(recordId) {
      const sealed = await AsyncStorage.getItem(`${prefix}${recordId}`);
      if (sealed === null) return null;
      return aesDecryptAsync(AESSealedData.fromCombined(sealed), key, {
        additionalData: aad(recordId),
      });
    },
    async write(recordId, bytes) {
      const sealed = await aesEncryptAsync(bytes, key, { additionalData: aad(recordId) });
      await AsyncStorage.setItem(`${prefix}${recordId}`, await sealed.combined("base64"));
    },
    async remove(recordId) {
      await AsyncStorage.removeItem(`${prefix}${recordId}`);
    },
    async clear() {
      const all = await AsyncStorage.getAllKeys();
      await AsyncStorage.removeMany(all.filter((key) => key.startsWith(prefix)));
      await SecureStore.deleteItemAsync(keyId);
      stores.delete(accountId);
    },
  };
}
