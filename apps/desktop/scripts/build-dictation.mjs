import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const [arch, destination] = process.argv.slice(2);
if (!["arm64", "x64", "universal"].includes(arch) || !destination) {
  throw new Error("Usage: build-dictation.mjs <arm64|x64|universal> <destination>");
}
const source = NodeURL.fileURLToPath(
  new URL("../../../native/dictation/macos.swift", import.meta.url),
);
await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).`);
}
const architectures = arch === "universal" ? ["arm64", "x64"] : [arch];
const outputs = [];
for (const architecture of architectures) {
  const output = architectures.length === 1 ? destination : `${destination}.${architecture}`;
  run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-emit-library",
    "-Xlinker",
    "-install_name",
    "-Xlinker",
    "@rpath/mines-dictation.dylib",
    "-target",
    `${architecture === "x64" ? "x86_64" : architecture}-apple-macosx13.0`,
    source,
    "-o",
    output,
  ]);
  outputs.push(output);
}
if (outputs.length > 1) {
  run("lipo", ["-create", ...outputs, "-output", destination]);
  await Promise.all(outputs.map((output) => NodeFSP.unlink(output)));
}
