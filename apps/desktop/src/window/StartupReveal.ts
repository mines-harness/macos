export type StartupRevealEvent = "paint" | "ready" | "error" | "fallback";
type StartupRevealAction = "wait" | "burst" | "reveal";

export function createStartupRevealGate() {
  let painted = false;
  let ready = false;
  let finished = false;
  return (event: StartupRevealEvent, reducedMotion = false): StartupRevealAction => {
    if (finished) return "wait";
    if (event === "error" || event === "fallback") {
      finished = true;
      return "reveal";
    }
    if (event === "paint") painted = true;
    if (event === "ready") ready = true;
    if (!painted || !ready) return "wait";
    finished = true;
    return reducedMotion ? "reveal" : "burst";
  };
}
