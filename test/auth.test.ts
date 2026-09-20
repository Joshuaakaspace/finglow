import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  generateApiKey,
  hashApiKey,
  hashesMatch,
  looksLikeApiKey,
  presentedKey,
} from "../kernel/auth.ts";
import { createTradingService, type TradingService } from "../services/trading/service.ts";
import { seedTradingDemo } from "../services/trading/demo.ts";
import { tempDir } from "./support/helpers.ts";
import type { Harness } from "../kernel/harness/harness.ts";

const inert: Harness = { id: "inert", runTurn: async () => ({ reply: "ok", toolCallCount: 0 }) };

describe("api key primitives", () => {
  test("generates distinct, recognisable keys", () => {
    const a = generateApiKey();
    const b = generateApiKey();
    assert.notEqual(a, b);
    assert.ok(looksLikeApiKey(a));
    assert.ok(!looksLikeApiKey("hunter2"));
    assert.ok(!looksLikeApiKey("extpo_short"));
  });

  test("hashes are stable and one-way", () => {
    const key = generateApiKey();
    assert.equal(hashApiKey(key), hashApiKey(key));
    assert.notEqual(hashApiKey(key), key);
    assert.match(hashApiKey(key), /^[0-9a-f]{64}$/);
  });

  test("compares hashes without leaking length mismatches", () => {
    const hash = hashApiKey("a");
    assert.ok(hashesMatch(hash, hash));
    assert.ok(!hashesMatch(hash, hashApiKey("b")));
    assert.ok(!hashesMatch(hash, "short"));
  });

  test("reads a key from either supported header", () => {
    assert.equal(presentedKey({ authorization: "Bearer abc" }), "abc");
    assert.equal(presentedKey({ authorization: "bearer abc" }), "abc");
    assert.equal(presentedKey({ "x-api-key": "abc" }), "abc");
    assert.equal(presentedKey({ authorization: "Basic abc" }), null);
    assert.equal(presentedKey({}), null);
  });
});

describe("key lifecycle in the store", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;

  beforeEach(() => {
    dir = tempDir();
    service = createTradingService({
      harness: inert,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
  });

  afterEach(() => {
    service.close();
    dir.cleanup();
  });

  test("authenticates a minted key and records its owner", () => {
    const { key } = service.store.createApiKey({ name: "ci", owner: "ops@firm.test", admin: true });
    const principal = service.store.authenticate(key);
    assert.equal(principal?.owner, "ops@firm.test");
    assert.equal(principal?.admin, true);
    assert.equal(principal?.name, "ci");
  });

  test("rejects an unknown key", () => {
    assert.equal(service.store.authenticate(generateApiKey()), null);
  });

  test("a revoked key stops working", () => {
    const { id, key } = service.store.createApiKey({ name: "temp", owner: "x@firm.test" });
    assert.ok(service.store.authenticate(key));
    assert.equal(service.store.revokeApiKey(id), true);
    assert.equal(service.store.authenticate(key), null);
    assert.equal(service.store.revokeApiKey(id), false, "revoking twice is not a second success");
  });

  test("never stores the plaintext key", () => {
    const { key } = service.store.createApiKey({ name: "k", owner: "x@firm.test" });
    const rows = service.store.db.prepare("SELECT key_hash FROM api_keys").all() as Array<{ key_hash: string }>;
    assert.ok(rows.every((r) => r.key_hash !== key));
    assert.ok(rows.some((r) => r.key_hash === hashApiKey(key)));
  });

  test("mints a bootstrap key only while none exists", () => {
    const first = service.ensureBootstrapKey("admin@local");
    assert.ok(first);
    assert.equal(service.store.authenticate(first.key)?.admin, true);
    assert.equal(service.ensureBootstrapKey("admin@local"), null);
  });
});

describe("per-owner access control over HTTP", () => {
  let dir: { path: string; cleanup: () => void };
  let service: TradingService;
  let close: () => Promise<void>;
  let port: number;
  let adminKey: string;
  let aliceKey: string;
  let bobKey: string;
  let aliceProject: string;

  const call = async (method: string, path: string, key?: string, body?: unknown) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (key) headers.authorization = `Bearer ${key}`;
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    dir = tempDir();
    service = createTradingService({
      harness: inert,
      databasePath: ":memory:",
      workspaceDir: join(dir.path, "ws"),
    });
    seedTradingDemo(service.store, service.domain);

    adminKey = service.ensureBootstrapKey("admin@firm.test")!.key;
    aliceKey = service.store.createApiKey({ name: "alice", owner: "alice@firm.test" }).key;
    bobKey = service.store.createApiKey({ name: "bob", owner: "bob@firm.test" }).key;

    const listener = await service.listen(0);
    close = listener.close;
    port = listener.port;

    const created = await call("POST", "/projects", aliceKey, { name: "Alice book" });
    aliceProject = created.body.id;
  });

  afterEach(async () => {
    await close();
    service.close();
    dir.cleanup();
  });

  test("a project is owned by the key that created it", async () => {
    const { body } = await call("GET", `/projects/${aliceProject}`, aliceKey);
    assert.equal(body.owner, "alice@firm.test");
  });

  test("another owner cannot see the project, and is not told it exists", async () => {
    const { status, body } = await call("GET", `/projects/${aliceProject}`, bobKey);
    assert.equal(status, 404, "a forbidden project must read as missing, not forbidden");
    assert.match(body.error, /project/);
  });

  test("listing is scoped to the caller", async () => {
    await call("POST", "/projects", bobKey, { name: "Bob book" });

    const alice = await call("GET", "/projects", aliceKey);
    assert.deepEqual(
      alice.body.projects.map((p: { owner: string }) => p.owner),
      ["alice@firm.test"],
    );

    const bob = await call("GET", "/projects", bobKey);
    assert.deepEqual(
      bob.body.projects.map((p: { owner: string }) => p.owner),
      ["bob@firm.test"],
    );
  });

  test("an admin key sees every project", async () => {
    await call("POST", "/projects", bobKey, { name: "Bob book" });
    const { body } = await call("GET", "/projects", adminKey);
    const owners = body.projects.map((p: { owner: string }) => p.owner);
    assert.ok(owners.includes("alice@firm.test"));
    assert.ok(owners.includes("bob@firm.test"));
  });

  test("a non-admin cannot create a project for someone else", async () => {
    const { status, body } = await call("POST", "/projects", aliceKey, {
      name: "Sneaky",
      owner: "bob@firm.test",
    });
    assert.equal(status, 403);
    assert.match(body.error, /admin key/);
  });

  test("sessions and runs inherit the project's ownership", async () => {
    const session = await call("POST", `/projects/${aliceProject}/sessions`, aliceKey, {});
    assert.equal(session.status, 201);

    assert.equal((await call("GET", `/sessions/${session.body.id}/entries`, aliceKey)).status, 200);
    assert.equal((await call("GET", `/sessions/${session.body.id}/entries`, bobKey)).status, 404);
    assert.equal((await call("POST", `/sessions/${session.body.id}/turns`, bobKey, { prompt: "hi" })).status, 404);
  });

  test("admin-only routes refuse an ordinary key", async () => {
    for (const path of ["/audit", "/metrics", "/keys"]) {
      const { status } = await call("GET", path, aliceKey);
      assert.equal(status, 403, `${path} should require admin`);
      assert.equal((await call("GET", path, adminKey)).status, 200, `${path} should serve an admin`);
    }
  });

  test("an admin can mint and revoke keys over the API", async () => {
    const minted = await call("POST", "/keys", adminKey, { name: "ci", owner: "ci@firm.test" });
    assert.equal(minted.status, 201);
    assert.ok(minted.body.key.startsWith("extpo_"));

    assert.equal((await call("GET", "/projects", minted.body.key)).status, 200);

    const revoked = await call("DELETE", `/keys/${minted.body.id}`, adminKey);
    assert.equal(revoked.status, 200);
    assert.equal((await call("GET", "/projects", minted.body.key)).status, 401);
  });

  test("the key list never exposes hashes or plaintext", async () => {
    const { body } = await call("GET", "/keys", adminKey);
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes("key_hash"));
    assert.ok(!serialised.includes(aliceKey));
  });
});
