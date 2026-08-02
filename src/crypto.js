const ENCRYPTION_PREFIX = "enc:v1:";
const ENCRYPTION_VERSION = 1;
const MESSAGE_FIELDS = ["sender_name", "chat_title", "text", "media_file_id"];

let cachedSecret = null;
let cachedKey = null;

export function validateEncryptionKey(secret) {
  decodeEncryptionKey(secret);
}

export async function encryptMessageFields(row, secret) {
  const encrypted = { ...row, encryption_version: ENCRYPTION_VERSION };
  await Promise.all(
    MESSAGE_FIELDS.map(async (field) => {
      encrypted[field] = await encryptString(
        row[field],
        secret,
        messageFieldContext(row, field),
      );
    }),
  );
  return encrypted;
}

export async function decryptMessageFields(row, secret) {
  if (!row) return row;
  const version = Number(row.encryption_version || 0);
  if (version === 0) return { ...row };
  if (version !== ENCRYPTION_VERSION) {
    throw new Error(`Неподдерживаемая версия шифрования сообщения: ${version}`);
  }

  const decrypted = { ...row };
  await Promise.all(
    MESSAGE_FIELDS.map(async (field) => {
      decrypted[field] = await decryptString(
        row[field],
        secret,
        messageFieldContext(row, field),
      );
    }),
  );
  return decrypted;
}

export async function encryptString(value, secret, context) {
  if (value == null || value === "") return value;
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(String(value));
  const additionalData = new TextEncoder().encode(String(context));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData, tagLength: 128 },
    key,
    plaintext,
  );
  return `${ENCRYPTION_PREFIX}${toBase64Url(iv)}:${toBase64Url(
    new Uint8Array(ciphertext),
  )}`;
}

export async function decryptString(value, secret, context) {
  if (value == null || value === "") return value;
  const serialized = String(value);
  if (!serialized.startsWith(ENCRYPTION_PREFIX)) {
    throw new Error("Повреждённое зашифрованное значение");
  }

  const payload = serialized.slice(ENCRYPTION_PREFIX.length);
  const separator = payload.indexOf(":");
  if (separator <= 0 || separator === payload.length - 1) {
    throw new Error("Повреждённое зашифрованное значение");
  }

  const iv = fromBase64Url(payload.slice(0, separator));
  const ciphertext = fromBase64Url(payload.slice(separator + 1));
  if (iv.length !== 12 || ciphertext.length < 16) {
    throw new Error("Повреждённое зашифрованное значение");
  }

  try {
    const key = await importEncryptionKey(secret);
    const additionalData = new TextEncoder().encode(String(context));
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData, tagLength: 128 },
      key,
      ciphertext,
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new Error("Не удалось расшифровать данные: неверный ключ или данные повреждены");
  }
}

function messageFieldContext(row, field) {
  return JSON.stringify([
    "messages",
    String(row.connection_id),
    String(row.chat_id),
    String(row.message_id),
    field,
  ]);
}

async function importEncryptionKey(secret) {
  const normalized = normalizeSecret(secret);
  if (cachedKey && cachedSecret === normalized) return cachedKey;
  const keyBytes = decodeEncryptionKey(normalized);
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  cachedSecret = normalized;
  cachedKey = key;
  return key;
}

function decodeEncryptionKey(secret) {
  const normalized = normalizeSecret(secret);
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new Error("ENCRYPTION_KEY должен быть 32-байтным ключом в формате Base64URL");
  }
  const bytes = fromBase64Url(normalized);
  if (bytes.length !== 32) {
    throw new Error("ENCRYPTION_KEY должен содержать ровно 32 байта");
  }
  return bytes;
}

function normalizeSecret(secret) {
  return String(secret || "").trim();
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = atob(normalized + padding);
  } catch {
    throw new Error("Некорректные данные Base64URL");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
