import { describe, expect, it } from "vite-plus/test";

import { createStartupRevealGate } from "./StartupReveal.ts";

describe("initial desktop reveal", () => {
  it("keeps the app hidden until both its first paint and mounted UI are ready", () => {
    const receive = createStartupRevealGate();
    expect(receive("paint")).toBe("wait");
    expect(receive("ready")).toBe("burst");
    expect(receive("ready")).toBe("wait");
    expect(receive("paint")).toBe("wait");
    expect(receive("fallback")).toBe("wait");
  });

  it("also accepts mounted readiness arriving before the native paint event", () => {
    const receive = createStartupRevealGate();
    expect(receive("ready")).toBe("wait");
    expect(receive("paint")).toBe("burst");
  });

  it("reveals directly with Reduced Motion", () => {
    const receive = createStartupRevealGate();
    expect(receive("paint", true)).toBe("wait");
    expect(receive("ready", true)).toBe("reveal");
  });

  it.each(["error", "fallback"] as const)(
    "shows the recoverable app surface without a success burst on %s",
    (event) => {
      const receive = createStartupRevealGate();
      expect(receive(event)).toBe("reveal");
      expect(receive("ready")).toBe("wait");
      expect(receive("paint")).toBe("wait");
    },
  );
});
