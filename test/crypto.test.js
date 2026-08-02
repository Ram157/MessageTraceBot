import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptMessageFields,
  decryptString,
  encryptMessageFields,
  encryptString,
  validateEncryptionKey,
} from "../src/crypto.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_KEY = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function messageRow() {
  return {
    connection_id: "connection-1",
    chat_id: 20,
    message_id: 30,
    sender_name: "Друг (@friend)",
    chat_title: "Личный чат",
    text: "Секретное сообщение",
    media_file_id: "telegram-file-id",
    encryption_version: 0,
  };
}

test("AES-GCM encrypts and decrypts all sensitive message fields", async () => {
  const original = messageRow();
  const encrypted = await encryptMessageFields(original, KEY);

  assert.equal(encrypted.encryption_version, 1);
  for (const field of ["sender_name", "chat_title", "text", "media_file_id"]) {
    assert.match(encrypted[field], /^enc:v1:/);
    assert.notEqual(encrypted[field], original[field]);
    assert.equal(encrypted[field].includes(original[field]), false);
  }

  const decrypted = await decryptMessageFields(encrypted, KEY);
  for (const field of ["sender_name", "chat_title", "text", "media_file_id"]) {
    assert.equal(decrypted[field], original[field]);
  }
});

test("each encryption uses a fresh nonce", async () => {
  const first = await encryptString("одинаковый текст", KEY, "same-context");
  const second = await encryptString("одинаковый текст", KEY, "same-context");
  assert.notEqual(first, second);
  assert.equal(await decryptString(first, KEY, "same-context"), "одинаковый текст");
  assert.equal(await decryptString(second, KEY, "same-context"), "одинаковый текст");
});

test("ciphertext is bound to its record context", async () => {
  const encrypted = await encryptString("секрет", KEY, "message-1:text");
  await assert.rejects(
    decryptString(encrypted, KEY, "message-2:text"),
    /неверный ключ|повреждены/,
  );
});

test("a different key cannot decrypt the value", async () => {
  const encrypted = await encryptString("секрет", KEY, "context");
  await assert.rejects(
    decryptString(encrypted, OTHER_KEY, "context"),
    /неверный ключ|повреждены/,
  );
});

test("legacy rows remain readable until the migration encrypts them", async () => {
  const original = messageRow();
  const legacy = await decryptMessageFields(original, KEY);
  assert.deepEqual(legacy, original);
  assert.notEqual(legacy, original);
});

test("empty and null values stay empty instead of becoming ciphertext", async () => {
  const row = { ...messageRow(), text: "", media_file_id: null };
  const encrypted = await encryptMessageFields(row, KEY);
  assert.equal(encrypted.text, "");
  assert.equal(encrypted.media_file_id, null);
  const decrypted = await decryptMessageFields(encrypted, KEY);
  assert.equal(decrypted.text, "");
  assert.equal(decrypted.media_file_id, null);
});

test("the encryption key must contain exactly 32 Base64URL bytes", () => {
  assert.doesNotThrow(() => validateEncryptionKey(KEY));
  assert.throws(() => validateEncryptionKey("too-short"), /32-байтным ключом/);
});
