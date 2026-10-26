import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  participantKey,
  participantLabel,
  participantOptions,
  participantGroupMembers,
  completeParticipantDraft,
} from "./draftParticipants";

const host = EnvironmentId.make("mac");
const mine = (id: string, title: string, environmentId = host) => ({
  environmentId,
  threadId: ThreadId.make(id),
  title,
});

describe("draft participants", () => {
  it("puts selected mines first after search is cleared and searches again without losing them", () => {
    const alpha = mine("alpha", "Alpha");
    const beta = mine("beta", "Beta");
    const gamma = mine("gamma", "Gamma");
    expect(participantOptions([alpha, beta, gamma], [gamma, beta], "")).toEqual([
      gamma,
      beta,
      alpha,
    ]);
    expect(participantOptions([alpha, beta, gamma], [gamma, beta], "alp")).toEqual([alpha]);
    expect(participantOptions([alpha, beta, gamma], [gamma, beta], "")).toEqual([
      gamma,
      beta,
      alpha,
    ]);
  });

  it("keeps same-id mines from different devices separate and preserves a selected offline mine", () => {
    const local = mine("same", "Local");
    const remote = mine("same", "Remote", EnvironmentId.make("linux"));
    expect(participantKey(local)).not.toBe(participantKey(remote));
    expect(participantOptions([local], [remote], "")).toEqual([remote, local]);
  });

  it("uses the first selected name and counts the remaining mines", () => {
    expect(participantLabel([])).toBe("Add participants");
    expect(participantLabel([mine("first", "Design")])).toBe("Design");
    expect(participantLabel([mine("first", "Design"), mine("second", "Build")])).toBe(
      "Design + 1 other",
    );
    expect(
      participantLabel(Array.from({ length: 8 }, (_, index) => mine(`${index}`, "Design"))),
    ).toBe("Design + 7 others");
  });

  it("creates unique valid mentions from duplicate, non-Latin and reserved mine names", () => {
    const members = participantGroupMembers([
      mine("one", "Design review"),
      mine("two", "Design review"),
      mine("three", "大家好"),
      mine("four", "everyone"),
    ]);
    expect(members.map((member) => member.alias)).toEqual([
      "design-review",
      "design-review-2",
      "member",
      "teammate",
    ]);
  });

  it("clears participants after acceptance only for the draft revision that was sent", () => {
    const sent = { revision: "sent", members: [mine("one", "Design")] };
    const changed = { revision: "changed", members: [mine("two", "Build")] };
    expect(completeParticipantDraft(sent, "sent")).toEqual({ revision: "", members: [] });
    expect(completeParticipantDraft(changed, "sent")).toBe(changed);
    expect(sent.members).toHaveLength(1);
  });
});
