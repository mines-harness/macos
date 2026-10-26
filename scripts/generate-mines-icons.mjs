import * as NodeFS from "node:fs";
import * as NodeZlib from "node:zlib";

// Original pixel geometry keeps the icon legible at menu-bar and app-icon sizes.
const directory = new URL("../assets/mines/", import.meta.url);
const checkOnly = process.argv.includes("--check");
if (!checkOnly) NodeFS.mkdirSync(directory, { recursive: true });
const writeAsset = (path, contents) => {
  const buffer = Buffer.from(contents);
  if (checkOnly) {
    if (!NodeFS.existsSync(path) || !NodeFS.readFileSync(path).equals(buffer)) {
      throw new Error(`Generated mines icon is stale: ${path}`);
    }
  } else {
    NodeFS.writeFileSync(path, buffer);
  }
};
const mine = (x, y) =>
  (x >= 12 && x < 20 && y >= 10 && y < 22) ||
  (x >= 10 && x < 22 && y >= 12 && y < 20) ||
  (x >= 15 && x < 17 && y >= 6 && y < 26) ||
  (x >= 6 && x < 26 && y >= 15 && y < 17) ||
  (x - y >= -1 && x - y <= 1 && x >= 8 && x < 24) ||
  (x + y >= 30 && x + y <= 32 && x >= 8 && x < 24);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};
const chunk = (name, data) => {
  const bytes = Buffer.concat([Buffer.from(name), data]);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(data.length);
  const suffix = Buffer.alloc(4);
  suffix.writeUInt32BE(crc(bytes));
  return Buffer.concat([prefix, bytes, suffix]);
};
function png(size, template = false, transparent = false, rounded = false) {
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const x = ((column + 0.5) * 32) / size;
      const y = ((row + 0.5) * 32) / size;
      const offset = row * (size * 4 + 1) + 1 + column * 4;
      const isMine = mine(x, y);
      const highlight = x >= 13 && x < 15 && y >= 12 && y < 14;
      const accent = x >= 23 && x < 27 && y >= 5 && y < 9;
      const radius = 7;
      const qx = Math.max(Math.abs(x - 16) - (16 - radius), 0);
      const qy = Math.max(Math.abs(y - 16) - (16 - radius), 0);
      const inside = qx * qx + qy * qy <= radius * radius;
      const color = template
        ? [0, 0, 0]
        : highlight
          ? [0, 0, 0]
          : isMine
            ? [240, 244, 239]
            : accent
              ? [142, 232, 176]
              : [0, 0, 0];
      rows[offset] = color[0];
      rows[offset + 1] = color[1];
      rows[offset + 2] = color[2];
      rows[offset + 3] =
        template || transparent ? (isMine && !highlight ? 255 : 0) : rounded && !inside ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const size of [16, 32, 180, 256, 512, 1024])
  writeAsset(new URL(`icon-${size}.png`, directory), png(size));
writeAsset(new URL("icon-macos-1024.png", directory), png(1024, false, false, true));
writeAsset(new URL("trayTemplate.png", directory), png(44, true));
writeAsset(new URL("monochrome.png", directory), png(512, false, true));
const icon = png(256);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 0;
ico[7] = 0;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(icon.length, 14);
ico.writeUInt32LE(22, 18);
writeAsset(new URL("icon.ico", directory), Buffer.concat([ico, icon]));
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#000"/><g fill="#f0f4ef"><path d="M12 10h8v2h2v8h-2v2h-8v-2h-2v-8h2zM15 6h2v20h-2zM6 15h20v2H6zM8 8h3v3H8zm13 13h3v3h-3zM21 8h3v3h-3zM8 21h3v3H8z"/></g><path fill="#000" d="M13 12h2v2h-2z"/><rect x="23" y="5" width="4" height="4" rx="1" fill="#8ee8b0"/></svg>`;
writeAsset(new URL("icon.svg", directory), svg);
// Keep the widget's internal asset name stable while replacing its visible mark.
writeAsset(
  new URL("../apps/mobile/assets/widget/T3Mark.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path fill="black" d="M12 10h8v2h2v8h-2v2h-8v-2h-2v-8h2zM15 6h2v20h-2zM6 15h20v2H6zM8 8h3v3H8zm13 13h3v3h-3zM21 8h3v3h-3zM8 21h3v3H8z"/></svg>`,
);

writeAsset(
  new URL("flag.svg", directory),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#8ee8b0" d="M7 3h12l-3 5 3 5H7z"/><path fill="currentColor" d="M5 3h2v16h5v2H2v-2h3z"/></svg>`,
);

for (const [file, bytes] of [
  ["favicon.ico", Buffer.concat([ico, icon])],
  ["favicon-16x16.png", png(16)],
  ["favicon-32x32.png", png(32)],
  ["apple-touch-icon.png", png(180)],
])
  writeAsset(new URL(`../apps/web/public/${file}`, import.meta.url), bytes);
