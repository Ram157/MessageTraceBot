export const ALLOWED_UPDATES = [
  "message",
  "business_connection",
  "business_message",
  "edited_business_message",
  "deleted_business_messages",
];

export const MEDIA_FIELDS = [
  { type: "photo", method: "sendPhoto", parameter: "photo" },
  { type: "video", method: "sendVideo", parameter: "video" },
  { type: "animation", method: "sendAnimation", parameter: "animation" },
  { type: "audio", method: "sendAudio", parameter: "audio" },
  { type: "document", method: "sendDocument", parameter: "document" },
  { type: "voice", method: "sendVoice", parameter: "voice" },
  { type: "video_note", method: "sendVideoNote", parameter: "video_note" },
  { type: "sticker", method: "sendSticker", parameter: "sticker" },
];

export function displayName(user) {
  if (!user) return "неизвестный отправитель";
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  if (user.username) return `${name || "Пользователь"} (@${user.username})`;
  return name || `ID ${user.id ?? "?"}`;
}

export function chatTitle(chat) {
  return chat?.title || displayName(chat);
}

export function compact(value, limit = 1500) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function splitText(value, limit = 4000) {
  const chunks = [];
  let remaining = String(value || "");
  while (remaining) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt < Math.floor(limit / 4)) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}

export function extractContent(message, forceProtected = false) {
  if (
    forceProtected ||
    message.has_protected_content ||
    message.paid_media ||
    message.story
  ) {
    return {
      text: "",
      contentType: "protected",
      mediaType: null,
      mediaFileId: null,
      protected: true,
    };
  }

  const text = String(message.text || message.caption || "");
  for (const media of MEDIA_FIELDS) {
    let value = message[media.type];
    if (!value) continue;
    if (media.type === "photo") value = value.at(-1);
    return {
      text,
      contentType: media.type,
      mediaType: media.type,
      mediaFileId: value?.file_id || null,
      protected: false,
    };
  }

  if (message.contact) {
    const contactName = [message.contact.first_name, message.contact.last_name]
      .filter(Boolean)
      .join(" ");
    return plainContent(
      `Контакт: ${contactName}; телефон: ${message.contact.phone_number || ""}`,
      "contact",
    );
  }
  if (message.location) {
    return plainContent(
      `Геопозиция: ${message.location.latitude}, ${message.location.longitude}`,
      "location",
    );
  }
  if (message.venue) {
    return plainContent(
      `Место: ${message.venue.title || ""}; ${message.venue.address || ""}`,
      "venue",
    );
  }
  if (message.poll) {
    const options = (message.poll.options || []).map((item) => item.text || "").join(", ");
    return plainContent(
      `Опрос: ${message.poll.question || ""}; варианты: ${options}`,
      "poll",
    );
  }
  if (message.dice) {
    return plainContent(
      `Кубик ${message.dice.emoji || ""}: ${message.dice.value ?? ""}`,
      "dice",
    );
  }
  if (text) return plainContent(text, "text");
  return plainContent("[тип сообщения не поддерживается архиватором]", "unsupported");
}

function plainContent(text, contentType) {
  return {
    text,
    contentType,
    mediaType: null,
    mediaFileId: null,
    protected: false,
  };
}

export function makeRecord(message, connectionId, options = {}) {
  const content = extractContent(message, Boolean(options.forceProtected));
  const sender = message.from || null;
  return {
    connectionId,
    chatId: Number(message.chat.id),
    messageId: Number(message.message_id),
    incoming: options.incoming === false ? 0 : 1,
    senderId: sender?.id ?? null,
    senderName: displayName(sender),
    chatTitle: chatTitle(message.chat),
    sentAt: Number(message.date || 0),
    editedAt: message.edit_date == null ? null : Number(message.edit_date),
    text: content.text,
    contentType: content.contentType,
    mediaType: content.mediaType,
    mediaFileId: content.mediaFileId,
    protected: content.protected ? 1 : 0,
  };
}

export function contentLabel(record) {
  if (Number(record.protected)) {
    return "[защищённое или исчезающее содержимое не сохранялось]";
  }
  if (record.text) return String(record.text);
  if (record.media_type || record.mediaType) {
    return `[${record.media_type || record.mediaType}]`;
  }
  return "[пустое сообщение]";
}

export function recordsEqual(oldRecord, newRecord) {
  return (
    String(oldRecord.text || "") === String(newRecord.text || "") &&
    (oldRecord.media_type || null) === (newRecord.mediaType || null) &&
    (oldRecord.media_file_id || null) === (newRecord.mediaFileId || null) &&
    Boolean(oldRecord.protected) === Boolean(newRecord.protected)
  );
}

export function formatEditReport(oldRecord, newRecord) {
  const before = oldRecord
    ? contentLabel(oldRecord)
    : "[предыдущая версия неизвестна — бот запущен позже сообщения]";
  return [
    "✏️ Сообщение изменено",
    `Чат: ${newRecord.chatTitle}`,
    `От: ${newRecord.senderName}`,
    `ID: ${newRecord.messageId}`,
    "",
    "Было:",
    compact(before),
    "",
    "Стало:",
    compact(contentLabel(newRecord)),
  ].join("\n");
}

export function formatDeleteReport(record) {
  const unknownDirection = record.content_type === "unknown";
  return [
    "🗑 Сообщение удалено",
    `Чат: ${record.chat_title}`,
    `От: ${record.sender_name}`,
    `ID: ${record.message_id}`,
    unknownDirection ? "Направление: неизвестно (сообщение было отправлено до запуска бота)" : null,
    "",
    "Содержимое:",
    compact(contentLabel(record), 2500),
  ]
    .filter((line) => line !== null)
    .join("\n");
}

export function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (a[index] || 0) ^ (b[index] || 0);
  }
  return mismatch === 0;
}
