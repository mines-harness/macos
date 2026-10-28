import * as NodeChildProcess from "node:child_process";

if (!process.env.MONITOR || !process.env.EXPECTED_ARCH)
  throw new Error("MONITOR and EXPECTED_ARCH are required.");

const monitor = NodeChildProcess.spawn(process.env.MONITOR, { stdio: ["pipe", "pipe", "inherit"] });
monitor.stdout.setEncoding("utf8");
let output = "";
let finished = false;
const exited = new Promise((resolve) => monitor.on("close", resolve));
try {
  const hello = await new Promise((resolve, reject) => {
    monitor.on("error", reject);
    monitor.on("close", () => reject(new Error(`Resource monitor exited before hello: ${output}`)));
    monitor.stdout.on("data", (chunk) => {
      output += chunk;
      const end = output.indexOf("\n");
      if (end !== -1) {
        try {
          resolve(JSON.parse(output.slice(0, end)));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
  if (hello.type !== "hello" || hello.arch !== process.env.EXPECTED_ARCH)
    throw new Error(`Unexpected hello: ${JSON.stringify(hello)}`);
  const send = (message) =>
    monitor.stdin.write(`${JSON.stringify({ version: hello.version, ...message })}\n`);
  send({ type: "configure", rootPid: process.pid, sampleIntervalMs: 1000 });
  send({ type: "sampleNow", requestId: "verify" });
  monitor.stdin.end();
  const exitCode = await exited;
  finished = true;
  const sample = output
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .find((message) => message.requestId === "verify");
  if (
    exitCode !== 0 ||
    sample?.type !== "snapshot" ||
    !sample.processes.some((candidate) => candidate.pid === process.pid)
  )
    throw new Error(`Resource monitor exited ${exitCode} with: ${output}`);
  console.log(`Resource monitor sampled ${sample.scannedProcessCount} processes.`);
} finally {
  if (!finished) {
    monitor.kill();
    await exited;
  }
}
