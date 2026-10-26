import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());
const legacyDirectories = vi.hoisted(() => ({ open: vi.fn(), remove: vi.fn() }));

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));
vi.mock("expo-file-system", () => ({
  Paths: { document: "file:///documents/" },
  Directory: class {
    exists = true;
    constructor(...args: unknown[]) {
      legacyDirectories.open(...args);
    }
    list() {
      return [];
    }
    delete() {
      legacyDirectories.remove();
    }
  },
  File: vi.fn(),
}));

import * as MobileDatabase from "./mobile-database";

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase(schemaVersion = 1) {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA user_version = ${schemaVersion}`);
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("initializes a fresh mines database without importing or deleting legacy files", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sqlite = yield* Effect.promise(() => sqliteDatabase(0));
        const database = yield* MobileDatabase.make;
        expect(openDatabaseAsync).toHaveBeenLastCalledWith("mines-client.db");
        expect(sqlite.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
        expect(yield* database.listCache("thread")).toEqual([]);
        expect(legacyDirectories.open).not.toHaveBeenCalled();
        expect(legacyDirectories.remove).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(() => sqliteDatabase());
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});
