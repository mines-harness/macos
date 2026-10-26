function resolveNativeLib0Crypto(context, moduleName, platform, appEntry) {
  if (
    (platform !== "ios" && platform !== "android") ||
    moduleName !== "lib0/webcrypto" ||
    !/[/\\]lib0[/\\](?:dist[/\\])?random\.(?:c?js)$/.test(context.originModulePath)
  ) {
    return null;
  }

  // Yjs entropy uses only getRandomValues; lib0's encryption modules still require full WebCrypto.
  return context.resolveRequest(
    { ...context, originModulePath: appEntry },
    "expo-crypto",
    platform,
  );
}

module.exports = { resolveNativeLib0Crypto };
