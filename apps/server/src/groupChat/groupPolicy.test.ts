import { describe, expect, it } from "@effect/vitest";
import {
  GroupId,
  IsoDateTime,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GroupDelivery,
  type GroupMember,
  type GroupRound,
} from "@t3tools/contracts";
import {
  handoffRefusal,
  nextWorkflowStage,
  renderGroupContext,
  routeGroupMessage,
} from "./groupPolicy.ts";

const groupId = GroupId.make("group:test");
const at = IsoDateTime.make("2026-10-25T00:00:00.000Z");
const members: ReadonlyArray<GroupMember> = ["UX", "UI", "Developer"].map((alias) => ({
  id: alias.toLowerCase(),
  groupId,
  threadId: ThreadId.make(`thread:${alias}`),
  projectId: ProjectId.make("project:test"),
  environmentId: null,
  alias,
  role: alias,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "example-model" },
  joinedAt: at,
}));
const delivery = (memberId: string, overrides: Partial<GroupDelivery> = {}): GroupDelivery => ({
  id: `delivery:${memberId}`,
  memberId,
  stage: "initial",
  status: "completed",
  runId: null,
  hop: 0,
  parentDeliveryId: null,
  request: "",
  contextThroughMessageId: null,
  error: null,
  ...overrides,
});
const round = (overrides: Partial<GroupRound> = {}): GroupRound => ({
  id: "round:test",
  groupId,
  userMessageId: "message:user",
  routing: "targeted",
  workflow: "team",
  status: "active",
  members,
  deliveries: [delivery("ux")],
  createdAt: at,
  completedAt: null,
  ...overrides,
});
const route = (text: string) =>
  routeGroupMessage({ groupId, message: text, clientRequestId: "request" }, members);

describe("group routing", () => {
  it("broadcasts once to every member and takes precedence over a named mention", () => {
    const routing = route("@UX please respond with @everyone");
    expect(routing).toEqual({ routing: "everyone", memberIds: ["ux", "ui", "developer"] });
    expect(handoffRefusal(round({ routing: "everyone" }), delivery("ux"), "ui")).toContain(
      "disabled",
    );
  });
  it("targets only named original threads, case-insensitively", () => {
    expect(route("@UX review this with @ui, @UX")).toEqual({
      routing: "targeted",
      memberIds: ["ux", "ui"],
    });
  });
  it("does not turn code, email, or escaped mentions into a broadcast", () => {
    expect(route("Use `@everyone` in code. foo@everyone.com \\@UI\n```ts\n@UX\n```").routing).toBe(
      "self-select",
    );
  });
  it("leaves unmentioned messages for independent member relevance decisions", () => {
    expect(route("What do you think?")).toEqual({
      routing: "self-select",
      memberIds: ["ux", "ui", "developer"],
    });
  });
});

describe("structured handoffs", () => {
  it("permits UX to ask UI, but prevents UI from cycling back to UX", () => {
    const first = delivery("ux");
    const second = delivery("ui", { stage: "handoff", hop: 1, parentDeliveryId: first.id });
    expect(handoffRefusal(round(), first, "ui")).toBeNull();
    expect(handoffRefusal(round({ deliveries: [first, second] }), second, "ux")).toContain(
      "earlier member",
    );
  });
  it("caps depth, total handoffs and turns per member independently", () => {
    expect(handoffRefusal(round(), delivery("ux", { hop: 3 }), "ui")).toContain("three-hop");
    expect(
      handoffRefusal(
        round({
          deliveries: Array.from({ length: 6 }, (_, index) =>
            delivery(`member-${index}`, { stage: "handoff" }),
          ),
        }),
        delivery("ux"),
        "ui",
      ),
    ).toContain("six-handoff");
    expect(
      handoffRefusal(
        round({
          deliveries: [delivery("ux"), delivery("ui"), delivery("ui", { id: "second-ui" })],
        }),
        delivery("ux"),
        "ui",
      ),
    ).toContain("two-turn");
  });
});

describe("bounded workflows", () => {
  it("advances a builder to reviewers and then exactly one correction", () => {
    const initial = round({ routing: "workflow", workflow: "build-review" });
    expect(nextWorkflowStage(initial, "ux")).toEqual({
      stage: "review",
      memberIds: ["ui", "developer"],
    });
    const review = {
      ...initial,
      deliveries: [
        ...initial.deliveries,
        delivery("ui", { stage: "review" }),
        delivery("developer", { stage: "review" }),
      ],
    };
    expect(nextWorkflowStage(review, "ux")).toEqual({ stage: "fix", memberIds: ["ux"] });
    expect(
      nextWorkflowStage(
        { ...review, deliveries: [...review.deliveries, delivery("ux", { stage: "fix" })] },
        "ux",
      ),
    ).toBeNull();
  });
  it("stops automatic workflow stages when a participant failed or is still running", () => {
    for (const status of ["failed", "running", "unavailable"] as const) {
      expect(
        nextWorkflowStage(
          round({
            routing: "workflow",
            workflow: "council",
            deliveries: [delivery("ux", { status })],
          }),
          "ux",
        ),
      ).toBeNull();
    }
  });
  it("bounds shared context and preserves the full participant roster", () => {
    const context = renderGroupContext(
      members,
      Array.from({ length: 30 }, (_, index) => ({
        id: `message:${index}`,
        groupId,
        roundId: "round:test",
        memberId: "ui",
        kind: "assistant" as const,
        text: "x".repeat(10_000),
        createdAt: at,
        truncated: false,
      })),
    );
    expect(context.length).toBeLessThan(25_000);
    expect(context).toContain("@UX (memberId=ux");
    expect(context).toContain("@Developer (memberId=developer");
  });
});
