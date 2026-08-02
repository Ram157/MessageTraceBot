import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/index.js";
import { decryptMessageFields } from "../src/crypto.js";

const ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

test("health route works without secrets", async () => {
  const response = await worker.fetch(new Request("https://example.workers.dev/health"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "telegram-business-watcher",
  });
});

test("unknown route returns 404", async () => {
  const response = await worker.fetch(new Request("https://example.workers.dev/nope"), {});
  assert.equal(response.status, 404);
});

test("setup route rejects an invalid admin secret", async () => {
  const request = new Request("https://example.workers.dev/setup", {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
  });
  const response = await worker.fetch(request, { SETUP_SECRET: "correct" });
  assert.equal(response.status, 401);
});

test("webhook rejects an invalid Telegram secret before parsing the update", async () => {
  const request = new Request("https://example.workers.dev/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong" },
  });
  const response = await worker.fetch(request, {
    BOT_TOKEN: "unused",
    WEBHOOK_SECRET: "correct",
    SETUP_SECRET: "unused",
    ENCRYPTION_KEY,
    DB: {},
  });
  assert.equal(response.status, 401);
});

test("webhook stores sensitive message fields as AES-GCM ciphertext", async () => {
  let storedValues = null;
  const DB = {
    prepare(sql) {
      return {
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async first() {
          if (sql.includes("FROM processed_updates")) return null;
          if (sql.includes("FROM business_connections")) {
            return { owner_user_id: 1, owner_chat_id: 1, is_enabled: 1 };
          }
          if (sql.includes("FROM chat_policies")) return null;
          throw new Error(`Unexpected first() query: ${sql}`);
        },
        async run() {
          if (sql.includes("INSERT INTO messages")) storedValues = this.values;
          return { success: true };
        },
      };
    },
  };
  const update = {
    update_id: 1,
    business_message: {
      business_connection_id: "connection-1",
      message_id: 10,
      date: 100,
      from: { id: 2, first_name: "Друг" },
      chat: { id: 2, type: "private", first_name: "Друг" },
      text: "Совершенно секретно",
    },
  };
  const response = await worker.fetch(
    new Request("https://example.workers.dev/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Bot-Api-Secret-Token": "correct",
      },
      body: JSON.stringify(update),
    }),
    {
      BOT_TOKEN: "unused",
      WEBHOOK_SECRET: "correct",
      SETUP_SECRET: "unused",
      ENCRYPTION_KEY,
      DB,
    },
  );

  assert.equal(response.status, 200);
  assert.ok(storedValues);
  assert.equal(storedValues[14], 1);
  for (const index of [5, 6, 9]) assert.match(storedValues[index], /^enc:v1:/);
  assert.equal(storedValues[9].includes("Совершенно секретно"), false);

  const decrypted = await decryptMessageFields(
    {
      connection_id: storedValues[0],
      chat_id: storedValues[1],
      message_id: storedValues[2],
      sender_name: storedValues[5],
      chat_title: storedValues[6],
      text: storedValues[9],
      media_file_id: storedValues[12],
      encryption_version: storedValues[14],
    },
    ENCRYPTION_KEY,
  );
  assert.equal(decrypted.sender_name, "Друг");
  assert.equal(decrypted.chat_title, "Друг");
  assert.equal(decrypted.text, "Совершенно секретно");
  assert.equal(decrypted.media_file_id, null);
});

test("admin encryption route migrates legacy rows without returning plaintext", async () => {
  const legacy = {
    connection_id: "connection-1",
    chat_id: 2,
    message_id: 10,
    sender_name: "Друг",
    chat_title: "Личный чат",
    text: "Старый открытый текст",
    media_file_id: "old-file-id",
    encryption_version: 0,
  };
  let updateStatement = null;
  const DB = {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        async all() {
          assert.match(sql, /WHERE encryption_version = 0/);
          return { results: [legacy] };
        },
        async first() {
          assert.match(sql, /COUNT\(\*\)/);
          return { total: 0 };
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 1);
      [updateStatement] = statements;
      return [{ meta: { changes: 1 } }];
    },
  };
  const response = await worker.fetch(
    new Request("https://example.workers.dev/admin/encrypt", {
      method: "POST",
      headers: { Authorization: "Bearer correct-admin" },
    }),
    {
      BOT_TOKEN: "unused",
      WEBHOOK_SECRET: "unused",
      SETUP_SECRET: "correct-admin",
      ENCRYPTION_KEY,
      DB,
    },
  );

  assert.equal(response.status, 200);
  const responseBody = await response.json();
  assert.deepEqual(responseBody, {
    ok: true,
    processed: 1,
    migrated: 1,
    remaining: 0,
  });
  assert.equal(JSON.stringify(responseBody).includes(legacy.text), false);
  assert.ok(updateStatement);
  for (const index of [0, 1, 2, 3]) assert.match(updateStatement.values[index], /^enc:v1:/);
  assert.equal(updateStatement.values.join("|").includes(legacy.text), true);
  assert.equal(updateStatement.values[2].includes(legacy.text), false);

  const decrypted = await decryptMessageFields(
    {
      ...legacy,
      sender_name: updateStatement.values[0],
      chat_title: updateStatement.values[1],
      text: updateStatement.values[2],
      media_file_id: updateStatement.values[3],
      encryption_version: 1,
    },
    ENCRYPTION_KEY,
  );
  assert.equal(decrypted.text, legacy.text);
  assert.equal(decrypted.media_file_id, legacy.media_file_id);
});
