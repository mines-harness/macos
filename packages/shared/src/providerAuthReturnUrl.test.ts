import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it("accepts a hosted return only for the explicitly configured origin", () => {
    const destination = "https://mines.example/settings/providers?instanceId=work&code=secret";
    expect(providerAuthReturnUrl(destination)).toBeUndefined();
    expect(providerAuthReturnUrl(destination, "https://mines.example")).toBe(
      "https://mines.example/settings/providers?instanceId=work",
    );
    expect(providerAuthReturnUrl(destination, "https://other.example")).toBeUndefined();
    expect(providerAuthReturnUrl(destination, "https://user@mines.example")).toBeUndefined();
  });
  it.each(["mines", "mines-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "mines://attacker/welcome",
    "mines://app/welcome/../evil",
    "https://attacker.example/welcome",
    "https://app.t3.codes/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
