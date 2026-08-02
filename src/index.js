import {
  ALLOWED_UPDATES,
  MEDIA_FIELDS,
  chatTitle,
  compact,
  contentLabel,
  formatDeleteReport,
  formatEditReport,
  makeRecord,
  recordsEqual,
  safeEqual,
  splitText,
} from "./core.js";
import {
  decryptMessageFields,
  encryptMessageFields,
  validateEncryptionKey,
} from "./crypto.js";

class TelegramAPIError extends Error {
  constructor(code, description) {
    super(description);
    this.name = "TelegramAPIError";
    this.code = Number(code || 0);
    this.description = String(description || "Telegram Bot API error");
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return json({ ok: true, service: "telegram-business-watcher" });
    }

    if (request.method === "POST" && url.pathname === "/setup") {
      if (!isAdminRequest(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      return setupWebhook(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/status") {
      if (!isAdminRequest(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      return adminStatus(env);
    }

    if (request.method === "POST" && url.pathname === "/admin/encrypt") {
      if (!isAdminRequest(request, env)) return json({ ok: false, error: "unauthorized" }, 401);
      return encryptLegacyMessages(env);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      return receiveWebhook(request, env);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};

function validateBindings(env) {
  const missing = ["BOT_TOKEN", "WEBHOOK_SECRET", "SETUP_SECRET", "ENCRYPTION_KEY"].filter(
    (name) => !env[name],
  );
  if (!env.DB) missing.push("DB");
  if (missing.length) throw new Error(`Не настроены Cloudflare bindings: ${missing.join(", ")}`);
  validateEncryptionKey(env.ENCRYPTION_KEY);
}

function isAdminRequest(request, env) {
  if (!env.SETUP_SECRET) return false;
  const authorization = request.headers.get("Authorization") || "";
  return safeEqual(authorization, `Bearer ${env.SETUP_SECRET}`);
}

async function setupWebhook(request, env) {
  try {
    validateBindings(env);
    const me = await telegram(env, "getMe", {});
    if (!me.can_connect_to_business) {
      return json(
        {
          ok: false,
          error: "business_mode_disabled",
          message: "Сначала включите Business Mode у бота через @BotFather.",
        },
        409,
      );
    }

    const webhookUrl = `${new URL(request.url).origin}/webhook`;
    await telegram(env, "setWebhook", {
      url: webhookUrl,
      secret_token: env.WEBHOOK_SECRET,
      allowed_updates: ALLOWED_UPDATES,
      max_connections: 1,
      drop_pending_updates: false,
    });
    const info = await telegram(env, "getWebhookInfo", {});
    return json({
      ok: true,
      bot: `@${me.username}`,
      webhook: info.url,
      pending_updates: info.pending_update_count,
    });
  } catch (error) {
    console.error("Webhook setup failed", safeError(error));
    return json({ ok: false, error: safeError(error) }, 502);
  }
}

async function adminStatus(env) {
  try {
    validateBindings(env);
    const [webhook, connections, cachedMessages, unencryptedMessages] = await Promise.all([
      telegram(env, "getWebhookInfo", {}),
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM business_connections WHERE is_enabled = 1",
      ).first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE incoming = 1 AND archived = 0",
      ).first(),
      env.DB.prepare(
        "SELECT COUNT(*) AS total FROM messages WHERE encryption_version = 0",
      ).first(),
    ]);
    return json({
      ok: true,
      webhook,
      active_connections: Number(connections?.total || 0),
      cached_messages: Number(cachedMessages?.total || 0),
      unencrypted_messages: Number(unencryptedMessages?.total || 0),
    });
  } catch (error) {
    console.error("Status check failed", safeError(error));
    return json({ ok: false, error: safeError(error) }, 502);
  }
}

async function encryptLegacyMessages(env) {
  try {
    validateBindings(env);
    const result = await env.DB.prepare(
      `SELECT * FROM messages
       WHERE encryption_version = 0
       ORDER BY connection_id, chat_id, message_id
       LIMIT 100`,
    ).all();
    const rows = result?.results || [];
    const encryptedRows = await Promise.all(
      rows.map((row) => encryptMessageFields(row, env.ENCRYPTION_KEY)),
    );

    let migrated = 0;
    if (encryptedRows.length) {
      const statements = encryptedRows.map((encrypted, index) => {
        const original = rows[index];
        return env.DB.prepare(
          `UPDATE messages SET
             sender_name = ?, chat_title = ?, text = ?, media_file_id = ?,
             encryption_version = 1
           WHERE connection_id = ? AND chat_id = ? AND message_id = ?
             AND encryption_version = 0
             AND sender_name IS ? AND chat_title IS ? AND text IS ? AND media_file_id IS ?`,
        ).bind(
          encrypted.sender_name,
          encrypted.chat_title,
          encrypted.text,
          encrypted.media_file_id,
          original.connection_id,
          original.chat_id,
          original.message_id,
          original.sender_name,
          original.chat_title,
          original.text,
          original.media_file_id,
        );
      });
      const batchResults = await env.DB.batch(statements);
      migrated = batchResults.reduce(
        (total, item) => total + Number(item?.meta?.changes || 0),
        0,
      );
    }

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM messages WHERE encryption_version = 0",
    ).first();
    return json({
      ok: true,
      processed: rows.length,
      migrated,
      remaining: Number(remaining?.total || 0),
    });
  } catch (error) {
    console.error("Message encryption migration failed", safeError(error));
    return json({ ok: false, error: safeError(error) }, 500);
  }
}

async function receiveWebhook(request, env) {
  try {
    validateBindings(env);
    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!safeEqual(suppliedSecret, env.WEBHOOK_SECRET)) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const update = await request.json();
    if (!Number.isSafeInteger(update.update_id)) {
      return json({ ok: false, error: "invalid_update" }, 400);
    }
    const duplicate = await env.DB.prepare(
      "SELECT 1 AS found FROM processed_updates WHERE update_id = ?",
    )
      .bind(update.update_id)
      .first();
    if (duplicate) return json({ ok: true, duplicate: true });

    await handleUpdate(env, update);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO processed_updates(update_id, processed_at) VALUES (?, ?)",
    )
      .bind(update.update_id, now())
      .run();

    if (update.update_id % 1000 === 0) {
      await env.DB.prepare("DELETE FROM processed_updates WHERE processed_at < ?")
        .bind(now() - 30 * 24 * 60 * 60)
        .run();
    }
    return json({ ok: true });
  } catch (error) {
    console.error("Webhook processing failed", safeError(error));
    return json({ ok: false, error: "processing_failed" }, 500);
  }
}

async function handleUpdate(env, update) {
  if (update.business_connection) {
    await handleConnection(env, update.business_connection);
  } else if (update.business_message) {
    await handleNewMessage(env, update.business_message);
  } else if (update.edited_business_message) {
    await handleEditedMessage(env, update.edited_business_message);
  } else if (update.deleted_business_messages) {
    await handleDeletedMessages(env, update.deleted_business_messages);
  } else if (update.message) {
    await handleBotMessage(env, update.message);
  }
}

async function handleConnection(env, connection) {
  await saveConnection(env, connection);
  const state = connection.is_enabled ? "подключён" : "отключён";
  await bestEffortText(
    env,
    Number(connection.user_chat_id),
    `✅ Business-бот ${state}.\nТеперь он отслеживает новые входящие сообщения в разрешённых личных чатах.`,
  );
}

async function handleBotMessage(env, message) {
  const text = String(message.text || "");
  if (!text.startsWith("/start") && !text.startsWith("/status")) return;
  const ownerChatId = Number(message.chat.id);
  if (text.startsWith("/status")) {
    const connection = await env.DB.prepare(
      `SELECT is_enabled FROM business_connections
       WHERE owner_chat_id = ? ORDER BY updated_at DESC LIMIT 1`,
    )
      .bind(ownerChatId)
      .first();
    await sendText(
      env,
      ownerChatId,
      connection?.is_enabled
        ? "✅ Business-подключение активно. Cloudflare Worker работает."
        : "⚠️ Активное Business-подключение пока не найдено.",
    );
    return;
  }

  await sendText(
    env,
    ownerChatId,
    [
      "Бот готов к подключению.",
      "",
      "1. Включите Business Mode через @BotFather.",
      "2. Подключите бота: Настройки Telegram → Telegram Business → Чат-боты.",
      "3. Разрешите доступ только к нужным личным чатам.",
      "",
      "Команда /status покажет состояние.",
    ].join("\n"),
  );
}

async function handleNewMessage(env, message) {
  const connectionId = String(message.business_connection_id);
  const connection = await ensureConnection(env, connectionId);
  const chat = message.chat || {};
  if (chat.type !== "private") return;

  if (message.message_auto_delete_timer_changed) {
    await setAutoDeletePolicy(
      env,
      connectionId,
      Number(chat.id),
      Number(message.message_auto_delete_timer_changed.message_auto_delete_time || 0),
    );
    return;
  }

  const senderId = Number(message.from?.id || 0);
  const incoming = senderId !== Number(connection.owner_user_id);
  if (!incoming) {
    const outgoing = makeRecord(message, connectionId, {
      incoming: false,
      forceProtected: true,
    });
    outgoing.contentType = "outgoing";
    await saveMessage(env, outgoing);
    return;
  }
  if (Number(chat.id) === Number(connection.owner_user_id)) return;

  const autoDeleteSeconds = await getAutoDeletePolicy(env, connectionId, Number(chat.id));
  const protectedContent = Boolean(message.has_protected_content) || autoDeleteSeconds > 0;
  const record = makeRecord(message, connectionId, {
    incoming: true,
    forceProtected: protectedContent,
  });
  await saveMessage(env, record);

  if (record.protected) {
    const reason =
      autoDeleteSeconds > 0
        ? `в чате включено автоудаление (${autoDeleteSeconds} сек.)`
        : "сообщение защищено от сохранения";
    await sendText(
      env,
      Number(connection.owner_chat_id),
      [
        "⚠️ Получено исчезающее/защищённое сообщение",
        `Чат: ${record.chatTitle}`,
        `От: ${record.senderName}`,
        `ID: ${record.messageId}`,
        `Причина: ${reason}. Содержимое не копировалось.`,
      ].join("\n"),
    );
  }
}

async function handleEditedMessage(env, message) {
  const connectionId = String(message.business_connection_id);
  const connection = await ensureConnection(env, connectionId);
  const chat = message.chat || {};
  if (chat.type !== "private") return;

  const incoming = Number(message.from?.id || 0) !== Number(connection.owner_user_id);
  if (!incoming) {
    const outgoing = makeRecord(message, connectionId, {
      incoming: false,
      forceProtected: true,
    });
    outgoing.contentType = "outgoing";
    await saveMessage(env, outgoing);
    return;
  }

  const chatId = Number(chat.id);
  const messageId = Number(message.message_id);
  const oldRecord = await getMessage(env, connectionId, chatId, messageId);
  const autoDeleteSeconds = await getAutoDeletePolicy(env, connectionId, chatId);
  const newRecord = makeRecord(message, connectionId, {
    incoming: true,
    forceProtected: Boolean(message.has_protected_content) || autoDeleteSeconds > 0,
  });

  if (oldRecord && recordsEqual(oldRecord, newRecord)) {
    await saveMessage(env, newRecord);
    return;
  }

  await sendText(
    env,
    Number(connection.owner_chat_id),
    formatEditReport(oldRecord, newRecord),
  );

  if (
    oldRecord &&
    !oldRecord.protected &&
    oldRecord.media_type &&
    oldRecord.media_file_id &&
    oldRecord.media_file_id !== newRecord.mediaFileId
  ) {
    await sendMediaWithFallback(
      env,
      Number(connection.owner_chat_id),
      oldRecord.media_type,
      oldRecord.media_file_id,
      `Предыдущая версия вложения из чата ${oldRecord.chat_title}, ID ${messageId}`,
      messageId,
    );
  }

  await saveMessage(env, newRecord);
}

async function handleDeletedMessages(env, event) {
  const connectionId = String(event.business_connection_id);
  const connection = await ensureConnection(env, connectionId);
  const chat = event.chat || {};
  if (chat.type !== "private") return;
  const chatId = Number(chat.id);

  for (const rawMessageId of event.message_ids || []) {
    const messageId = Number(rawMessageId);
    let record = await getMessage(env, connectionId, chatId, messageId);
    if (!record) {
      await insertUnknownDeletion(env, connectionId, chatId, messageId, chatTitle(chat));
      record = await getMessage(env, connectionId, chatId, messageId);
    }
    if (!record) continue;

    if (!record.incoming) {
      await finalizeMessage(env, connectionId, chatId, messageId);
      continue;
    }

    await env.DB.prepare(
      `UPDATE messages SET deleted_at = COALESCE(deleted_at, ?)
       WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
    )
      .bind(now(), connectionId, chatId, messageId)
      .run();

    if (!record.report_sent) {
      await sendText(env, Number(connection.owner_chat_id), formatDeleteReport(record));
      await env.DB.prepare(
        `UPDATE messages SET report_sent = 1
         WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
      )
        .bind(connectionId, chatId, messageId)
        .run();
    }

    if (!record.media_sent && record.media_type && record.media_file_id) {
      await sendMediaWithFallback(
        env,
        Number(connection.owner_chat_id),
        record.media_type,
        record.media_file_id,
        `Удалённое вложение из чата ${record.chat_title}, ID ${messageId}`,
        messageId,
      );
      await env.DB.prepare(
        `UPDATE messages SET media_sent = 1
         WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
      )
        .bind(connectionId, chatId, messageId)
        .run();
    } else if (!record.media_sent) {
      await env.DB.prepare(
        `UPDATE messages SET media_sent = 1
         WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
      )
        .bind(connectionId, chatId, messageId)
        .run();
    }

    await finalizeMessage(env, connectionId, chatId, messageId);
  }
}

async function saveConnection(env, connection) {
  await env.DB.prepare(
    `INSERT INTO business_connections(
       connection_id, owner_user_id, owner_chat_id, is_enabled, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(connection_id) DO UPDATE SET
       owner_user_id = excluded.owner_user_id,
       owner_chat_id = excluded.owner_chat_id,
       is_enabled = excluded.is_enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(
      String(connection.id),
      Number(connection.user.id),
      Number(connection.user_chat_id),
      connection.is_enabled ? 1 : 0,
      now(),
    )
    .run();
}

async function ensureConnection(env, connectionId) {
  let connection = await env.DB.prepare(
    "SELECT * FROM business_connections WHERE connection_id = ?",
  )
    .bind(connectionId)
    .first();
  if (connection) return connection;

  const remote = await telegram(env, "getBusinessConnection", {
    business_connection_id: connectionId,
  });
  await saveConnection(env, remote);
  connection = await env.DB.prepare(
    "SELECT * FROM business_connections WHERE connection_id = ?",
  )
    .bind(connectionId)
    .first();
  if (!connection) throw new Error("Не удалось сохранить Business Connection");
  return connection;
}

async function saveMessage(env, record) {
  const row = await encryptMessageFields(
    {
      connection_id: record.connectionId,
      chat_id: record.chatId,
      message_id: record.messageId,
      incoming: record.incoming,
      sender_id: record.senderId,
      sender_name: record.senderName,
      chat_title: record.chatTitle,
      sent_at: record.sentAt,
      edited_at: record.editedAt,
      text: record.text,
      content_type: record.contentType,
      media_type: record.mediaType,
      media_file_id: record.mediaFileId,
      protected: record.protected,
    },
    env.ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT INTO messages(
       connection_id, chat_id, message_id, incoming, sender_id, sender_name,
       chat_title, sent_at, edited_at, text, content_type, media_type,
       media_file_id, protected, encryption_version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, chat_id, message_id) DO UPDATE SET
       incoming = excluded.incoming,
       sender_id = excluded.sender_id,
       sender_name = excluded.sender_name,
       chat_title = excluded.chat_title,
       sent_at = excluded.sent_at,
       edited_at = excluded.edited_at,
       text = excluded.text,
       content_type = excluded.content_type,
       media_type = excluded.media_type,
       media_file_id = excluded.media_file_id,
       protected = excluded.protected,
       encryption_version = excluded.encryption_version`,
  )
    .bind(
      row.connection_id,
      row.chat_id,
      row.message_id,
      row.incoming,
      row.sender_id,
      row.sender_name,
      row.chat_title,
      row.sent_at,
      row.edited_at,
      row.text,
      row.content_type,
      row.media_type,
      row.media_file_id,
      row.protected,
      row.encryption_version,
    )
    .run();
}

async function getMessage(env, connectionId, chatId, messageId) {
  const row = await env.DB.prepare(
    `SELECT * FROM messages
     WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
  )
    .bind(connectionId, chatId, messageId)
    .first();
  return decryptMessageFields(row, env.ENCRYPTION_KEY);
}

async function insertUnknownDeletion(env, connectionId, chatId, messageId, title) {
  const row = await encryptMessageFields(
    {
      connection_id: connectionId,
      chat_id: chatId,
      message_id: messageId,
      sender_name: "неизвестный отправитель",
      chat_title: title,
      text: "",
      media_file_id: null,
    },
    env.ENCRYPTION_KEY,
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO messages(
       connection_id, chat_id, message_id, incoming, sender_id, sender_name,
       chat_title, sent_at, text, content_type, protected, deleted_at, media_sent,
       encryption_version
     ) VALUES (?, ?, ?, 1, NULL, ?, ?, 0, ?, 'unknown', 0, ?, 1, ?)`,
  )
    .bind(
      row.connection_id,
      row.chat_id,
      row.message_id,
      row.sender_name,
      row.chat_title,
      row.text,
      now(),
      row.encryption_version,
    )
    .run();
}

async function finalizeMessage(env, connectionId, chatId, messageId) {
  await env.DB.prepare(
    `UPDATE messages SET
       archived = 1,
       text = '',
       media_file_id = NULL,
       deleted_at = COALESCE(deleted_at, ?),
       media_sent = 1
     WHERE connection_id = ? AND chat_id = ? AND message_id = ?`,
  )
    .bind(now(), connectionId, chatId, messageId)
    .run();
}

async function setAutoDeletePolicy(env, connectionId, chatId, seconds) {
  await env.DB.prepare(
    `INSERT INTO chat_policies(connection_id, chat_id, auto_delete_seconds, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(connection_id, chat_id) DO UPDATE SET
       auto_delete_seconds = excluded.auto_delete_seconds,
       updated_at = excluded.updated_at`,
  )
    .bind(connectionId, chatId, seconds, now())
    .run();
}

async function getAutoDeletePolicy(env, connectionId, chatId) {
  const row = await env.DB.prepare(
    `SELECT auto_delete_seconds FROM chat_policies
     WHERE connection_id = ? AND chat_id = ?`,
  )
    .bind(connectionId, chatId)
    .first();
  return Number(row?.auto_delete_seconds || 0);
}

async function telegram(env, method, payload) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new TelegramAPIError(0, "Cloudflare не смог подключиться к Telegram Bot API");
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new TelegramAPIError(response.status, "Telegram вернул некорректный ответ");
  }
  if (!data.ok) throw new TelegramAPIError(data.error_code, data.description);
  return data.result;
}

async function sendText(env, chatId, text) {
  for (const chunk of splitText(text)) {
    await telegram(env, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      link_preview_options: { is_disabled: true },
    });
  }
}

async function bestEffortText(env, chatId, text) {
  try {
    await sendText(env, chatId, text);
  } catch (error) {
    if (!(error instanceof TelegramAPIError) || ![400, 403].includes(error.code)) throw error;
    console.warn("Owner notification skipped", error.code);
  }
}

async function sendMedia(env, chatId, mediaType, fileId, caption) {
  const media = MEDIA_FIELDS.find((item) => item.type === mediaType);
  if (!media) throw new TelegramAPIError(400, `Неподдерживаемый тип медиа: ${mediaType}`);
  const payload = { chat_id: chatId, [media.parameter]: fileId };
  if (!new Set(["sticker", "video_note"]).has(mediaType)) {
    payload.caption = compact(caption, 950);
  }
  await telegram(env, media.method, payload);
}

async function sendMediaWithFallback(env, chatId, mediaType, fileId, caption, messageId) {
  try {
    await sendMedia(env, chatId, mediaType, fileId, caption);
  } catch (error) {
    if (!(error instanceof TelegramAPIError) || error.code !== 400) throw error;
    await sendText(
      env,
      chatId,
      `⚠️ Вложение сообщения ID ${messageId} не удалось повторно отправить: Telegram больше не принимает его file_id.`,
    );
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function safeError(error) {
  if (error instanceof TelegramAPIError) {
    return `Telegram API ${error.code}: ${error.description}`;
  }
  return error instanceof Error ? error.message : "unknown_error";
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
