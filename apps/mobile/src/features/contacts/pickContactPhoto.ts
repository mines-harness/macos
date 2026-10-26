export async function pickContactPhoto(): Promise<string | null> {
  const picker = await import("expo-image-picker");
  const result = await picker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsEditing: true,
    aspect: [1, 1],
    quality: 1,
  });
  if (result.canceled || !result.assets[0]) return null;
  const { ImageManipulator, SaveFormat } = await import("expo-image-manipulator");
  const image = await ImageManipulator.manipulate(result.assets[0].uri)
    .resize({ width: 64, height: 64 })
    .renderAsync();
  try {
    const photo = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.75, base64: true });
    const avatar = photo.base64 ? `data:image/jpeg;base64,${photo.base64}` : null;
    if (avatar === null || avatar.length > 16_384)
      throw new Error("Choose a smaller profile photo.");
    return avatar;
  } finally {
    image.release();
  }
}
