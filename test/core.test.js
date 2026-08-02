import assert from "node:assert/strict";
import test from "node:test";

import {
  contentLabel,
  extractContent,
  formatEditReport,
  makeRecord,
  recordsEqual,
  safeEqual,
  splitText,
} from "../src/core.js";

function message(text = "Привет") {
  return {
    business_connection_id: "connection-1",
    message_id: 10,
    date: 100,
    from: { id: 2, first_name: "Друг" },
    chat: { id: 2, type: "private", first_name: "Друг" },
    text,
  };
}

test("extractContent extracts text", () => {
  const content = extractContent({ text: "Привет" });
  assert.equal(content.text, "Привет");
  assert.equal(content.contentType, "text");
});

test("extractContent uses largest Telegram photo file_id", () => {
  const content = extractContent({
    caption: "Фото",
    photo: [{ file_id: "small" }, { file_id: "large" }],
  });
  assert.equal(content.mediaType, "photo");
  assert.equal(content.mediaFileId, "large");
});

test("protected content is never copied", () => {
  const content = extractContent({ text: "секрет", has_protected_content: true });
  assert.equal(content.protected, true);
  assert.equal(content.text, "");
  assert.equal(content.mediaFileId, null);
});

test("paid media and stories are treated as protected", () => {
  assert.equal(extractContent({ paid_media: {} }).protected, true);
  assert.equal(extractContent({ story: {} }).protected, true);
});

test("makeRecord and edit report preserve before/after", () => {
  const oldRecord = makeRecord(message("Первая версия"), "connection-1");
  const newRecord = makeRecord(message("Вторая версия"), "connection-1");
  const databaseOldRecord = {
    text: oldRecord.text,
    protected: oldRecord.protected,
    media_type: oldRecord.mediaType,
    media_file_id: oldRecord.mediaFileId,
  };
  assert.equal(recordsEqual(databaseOldRecord, newRecord), false);
  const report = formatEditReport(databaseOldRecord, newRecord);
  assert.match(report, /Первая версия/);
  assert.match(report, /Вторая версия/);
});

test("contentLabel does not reveal protected text", () => {
  assert.equal(
    contentLabel({ protected: 1, text: "не показывать" }),
    "[защищённое или исчезающее содержимое не сохранялось]",
  );
});

test("splitText stays within Telegram limit", () => {
  const chunks = splitText("а".repeat(9000), 4000);
  assert.deepEqual(
    chunks.map((chunk) => chunk.length),
    [4000, 4000, 1000],
  );
});

test("safeEqual compares secrets", () => {
  assert.equal(safeEqual("abc_123", "abc_123"), true);
  assert.equal(safeEqual("abc_123", "abc_124"), false);
  assert.equal(safeEqual("short", "much-longer"), false);
});
