import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { MinesCatalog, catalogHostId } from "@t3tools/client-runtime/catalog";
import {
  participantKey,
  participantLabel,
  participantOptions,
  participantGroupMembers,
  completeParticipantDraft,
  sectionParticipantThreads,
} from "./draftParticipants";

const host = EnvironmentId.make("mac");
const mine = (id: string, title: string, environmentId = host) => ({
  environmentId,
  threadId: ThreadId.make(id),
  title,
});

describe("draft participants", () => {
  it("limits suggestions and search to all projects in the current section, by identity", () => {
    const catalog = new MinesCatalog();
    const section = catalog.createSection("Product");
    const other = catalog.createSection("Product");
    const project = (id: string, parentId: string | null, environmentId = host) => {
      const entityId = catalogHostId("project", environmentId, id);
      catalog.upsert({ id: entityId, kind: "project", title: id }, { parentId });
      return entityId;
    };
    const context = project("ios", section);
    project("web", section);
    project("other", other);
    project("free", null);
    project("ios", other, EnvironmentId.make("linux"));
    project("web", section, EnvironmentId.make("linux"));
    const threads = [
      { ...mine("one", "Build iOS"), id: ThreadId.make("one"), projectId: "ios" },
      { ...mine("two", "Build web"), id: ThreadId.make("two"), projectId: "web" },
      { ...mine("three", "Build elsewhere"), id: ThreadId.make("three"), projectId: "other" },
      { ...mine("four", "Build free"), id: ThreadId.make("four"), projectId: "free" },
      {
        ...mine("five", "Build remote", EnvironmentId.make("linux")),
        id: ThreadId.make("five"),
        projectId: "ios",
      },
      {
        ...mine("six", "Build remote web", EnvironmentId.make("linux")),
        id: ThreadId.make("six"),
        projectId: "web",
      },
    ];
    const scoped = sectionParticipantThreads(catalog.getSnapshot(), context, threads);
    expect(scoped.sectionId).toBe(section);
    expect(scoped.threads.map((thread) => thread.id)).toEqual(["one", "two", "six"]);
    expect(
      participantOptions(scoped.threads, [], "Build").map((thread) => thread.threadId),
    ).toEqual(["one", "two", "six"]);
    expect(sectionParticipantThreads(catalog.getSnapshot(), null, threads).threads).toBe(threads);
    expect(
      sectionParticipantThreads(
        catalog.getSnapshot(),
        catalogHostId("project", host, "free"),
        threads,
      ).threads,
    ).toBe(threads);
    // A mine moved directly into another section follows its own placement.
    catalog.upsert(
      { id: catalogHostId("thread", host, "one"), kind: "thread", title: "Build iOS" },
      { parentId: other },
    );
    expect(
      sectionParticipantThreads(catalog.getSnapshot(), context, threads).threads.map(
        (thread) => thread.id,
      ),
    ).toEqual(["two", "six"]);
  });
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
