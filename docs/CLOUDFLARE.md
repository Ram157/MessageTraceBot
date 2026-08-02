# Развёртывание Telegram Business Watcher на Cloudflare

Эта инструкция описывает чистую установку, подключение Telegram и безопасное обновление уже работающего Worker. Команды приведены для PowerShell; на macOS и Linux замените `Copy-Item` на `cp`.

## 1. Что понадобится

- Node.js 22 или новее;
- аккаунт [Cloudflare](https://dash.cloudflare.com/sign-up);
- Git;
- Telegram-бот от @BotFather;
- возможность включить у бота **Business Mode**;
- доступ к настройкам Telegram Business аккаунта, к которому подключается бот.

Проверьте локальные версии:

```powershell
node --version
npm --version
git --version
```

Если PowerShell запрещает запуск `npm.ps1` или `npx.ps1`, используйте `npm.cmd` и `npx.cmd` во всех командах ниже.

## 2. Создание Telegram-бота

1. Откройте официальный чат @BotFather.
2. Создайте бота командой `/newbot` или выберите существующего.
3. Если токен когда-либо публиковался, выполните `/revoke` и получите новый.
4. В настройках выбранного бота включите **Business Mode**.
5. Сохраните новый `BOT_TOKEN` в менеджере паролей. Не отправляйте его в переписку и не добавляйте в Git.

## 3. Подготовка проекта

```powershell
git clone https://github.com/<имя-пользователя>/telegram-business-watcher.git
cd telegram-business-watcher
npm ci
Copy-Item wrangler.example.jsonc wrangler.jsonc
```

Файл `wrangler.jsonc` содержит конфигурацию конкретного Cloudflare-аккаунта и исключён из Git. Публичный `wrangler.example.jsonc` можно свободно коммитить.

## 4. Вход в Cloudflare

```powershell
npx wrangler login
```

Wrangler откроет браузер. Выберите нужный аккаунт Cloudflare и подтвердите доступ.

Проверка авторизации:

```powershell
npx wrangler whoami
```

## 5. Создание D1-базы

Создайте базу:

```powershell
npm run db:create
```

Wrangler напечатает UUID в поле `database_id`. Откройте локальный `wrangler.jsonc` и замените:

```json
"database_id": "00000000-0000-0000-0000-000000000000"
```

на фактический UUID созданной базы.

Примените все миграции к удалённой D1:

```powershell
npm run db:migrate:remote
```

Wrangler покажет список миграций и может запросить подтверждение. Для чистой установки должны примениться как минимум:

- `0001_init.sql` — основные таблицы;
- `0002_encrypt_messages.sql` — версия шифрования записей.

## 6. Создание секретов

Worker использует четыре секрета:

| Секрет | Назначение |
| --- | --- |
| `BOT_TOKEN` | Доступ к Telegram Bot API |
| `WEBHOOK_SECRET` | Проверка запросов Telegram webhook |
| `SETUP_SECRET` | Защита административных маршрутов |
| `ENCRYPTION_KEY` | 32-байтный ключ AES-256-GCM для D1 |

Создайте три независимых случайных значения:

```powershell
node -e 'const { randomBytes } = require("node:crypto"); for (const name of ["WEBHOOK_SECRET", "SETUP_SECRET", "ENCRYPTION_KEY"]) console.log(name + "=" + randomBytes(32).toString("base64url"));'
```

Создайте локальный файл секретов:

```powershell
Copy-Item .dev.vars.example .dev.vars
```

Замените шаблонные значения в `.dev.vars`:

```dotenv
BOT_TOKEN=ТОКЕН_ОТ_BOTFATHER
WEBHOOK_SECRET=СЛУЧАЙНОЕ_ЗНАЧЕНИЕ_1
SETUP_SECRET=СЛУЧАЙНОЕ_ЗНАЧЕНИЕ_2
ENCRYPTION_KEY=СЛУЧАЙНОЕ_ЗНАЧЕНИЕ_3
```

`.dev.vars` исключён из Git. Дополнительно сохраните `ENCRYPTION_KEY` и `SETUP_SECRET` в менеджере паролей.

> [!CAUTION]
> Не используйте одно значение для нескольких секретов. Не заменяйте `ENCRYPTION_KEY` после появления данных без отдельной процедуры ротации.

## 7. Первое развёртывание

Загрузите код и секреты одной командой:

```powershell
npx wrangler deploy --secrets-file .dev.vars
```

Параметр `--secrets-file` передаёт значения в Cloudflare Secrets. Секреты не встраиваются в исходный код и не появляются в `wrangler.jsonc`.

После успешного развёртывания Wrangler напечатает адрес вида:

```text
https://telegram-business-watcher.<ваш-workers-поддомен>.workers.dev
```

Сохраните его как `$workerUrl`:

```powershell
$workerUrl = "https://telegram-business-watcher.<ваш-workers-поддомен>.workers.dev"
```

Проверьте health check:

```powershell
Invoke-RestMethod "$workerUrl/health"
```

Ожидаемый ответ:

```text
ok      : True
service : telegram-business-watcher
```

## 8. Регистрация Telegram webhook

Введите `SETUP_SECRET` без добавления его в историю команд:

```powershell
$setupSecret = Read-Host "Введите SETUP_SECRET"
```

Зарегистрируйте webhook:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "$workerUrl/setup" `
  -Headers @{ Authorization = "Bearer $setupSecret" }
```

Успешный ответ содержит:

```text
ok              : True
bot             : @имя_бота
webhook         : https://...workers.dev/webhook
pending_updates : 0
```

Worker передаёт Telegram случайный `WEBHOOK_SECRET`; после этого Telegram добавляет его в заголовок каждого webhook-запроса.

## 9. Подключение к Telegram Business

1. Откройте своего бота и отправьте `/start`.
2. В Telegram откройте **Настройки → Telegram Business → Чат-боты**.
3. Выберите созданного бота.
4. Разрешите доступ только к тем личным чатам, которые должны обрабатываться.
5. Отправьте боту `/status`.

Боту не нужны права на изменение профиля или самостоятельное удаление сообщений.

## 10. Проверка установки

Проверьте административный статус:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "$workerUrl/admin/status" `
  -Headers @{ Authorization = "Bearer $setupSecret" }
```

Обратите внимание на поля:

- `active_connections` — число активных Business-подключений;
- `cached_messages` — число ожидающих входящих сообщений;
- `unencrypted_messages` — число старых незашифрованных записей;
- `webhook.url` — текущий адрес webhook;
- `webhook.pending_update_count` — очередь Telegram.

Функциональная проверка:

1. Получите обычное входящее сообщение в разрешённом личном чате.
2. Попросите отправителя изменить сообщение — владелец должен получить «было / стало».
3. Попросите удалить сообщение — владелец должен получить сохранённое содержимое.
4. Убедитесь, что защищённые и автоудаляемые сообщения не копируются.

## 11. Обновление существующего Worker до версии с шифрованием

Этот раздел нужен, если Worker был развёрнут до появления `ENCRYPTION_KEY`.

1. Обновите код и зависимости:

   ```powershell
   git pull
   npm ci
   ```

2. Примените новую миграцию до развёртывания кода:

   ```powershell
   npm run db:migrate:remote
   ```

3. Создайте отдельный 32-байтный ключ:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
   ```

4. Сохраните его в менеджере паролей и добавьте в Cloudflare:

   ```powershell
   npx wrangler secret put ENCRYPTION_KEY
   ```

5. Разверните актуальный код:

   ```powershell
   npm test
   npm run check
   npm run deploy
   ```

Новые записи теперь шифруются сразу. Старые записи остаются читаемыми, но открытыми, пока вы не выполните следующий необязательный шаг.

### Шифрование старых записей

Маршрут обрабатывает до 100 записей за один запрос и не возвращает их содержимое:

```powershell
$workerUrl = "https://telegram-business-watcher.<ваш-workers-поддомен>.workers.dev"
$setupSecret = Read-Host "Введите SETUP_SECRET"

do {
  $result = Invoke-RestMethod `
    -Method Post `
    -Uri "$workerUrl/admin/encrypt" `
    -Headers @{ Authorization = "Bearer $setupSecret" }

  $result
} while ($result.remaining -gt 0)
```

`remaining: 0` означает, что старых незашифрованных записей больше нет. Этот шаг можно пропустить: новые сообщения всё равно будут зашифрованы.

## 12. Обычные обновления

```powershell
git pull
npm ci
npm run db:migrate:remote
npm test
npm run check
npm run deploy
```

Повторно запускать `/setup` нужно только после изменения webhook, `WEBHOOK_SECRET` или списка получаемых обновлений.

## 13. Работа с секретами

Изменить отдельный секрет:

```powershell
npx wrangler secret put ИМЯ_СЕКРЕТА
```

Посмотреть только имена настроенных секретов:

```powershell
npx wrangler secret list
```

`wrangler secret put` создаёт и сразу развёртывает новую версию Worker. Значение секрета после загрузки не отображается.

Особенности ротации:

- после смены `BOT_TOKEN` проверьте `/setup` и `/admin/status`;
- после смены `WEBHOOK_SECRET` немедленно повторите `/setup`, иначе Telegram временно будет получать `401`;
- `SETUP_SECRET` можно заменить обычной командой `secret put`;
- `ENCRYPTION_KEY` нельзя просто заменить: сначала требуется отдельная миграция всех ciphertext на новый ключ.

## 14. Логи и диагностика

Поток логов:

```powershell
npm run logs
```

Список неприменённых миграций:

```powershell
npx wrangler d1 migrations list telegram-business-watcher --remote
```

Частые проблемы:

| Симптом | Что проверить |
| --- | --- |
| `Не настроены Cloudflare bindings` | Наличие всех четырёх Secrets и binding `DB` |
| `database_id` некорректен | UUID фактической D1 в локальном `wrangler.jsonc` |
| `/webhook` отвечает `401` | Совпадение `WEBHOOK_SECRET` в Worker и настройке Telegram через `/setup` |
| `/setup` отвечает `business_mode_disabled` | Business Mode в @BotFather |
| `/status` не находит подключение | Подключение бота в настройках Telegram Business |
| Вложение не отправляется повторно | Telegram мог перестать принимать сохранённый `file_id` |
| Ошибка расшифровки | Worker получил другой `ENCRYPTION_KEY` или ciphertext повреждён |

## 15. GitHub Actions

Включённый workflow `.github/workflows/ci.yml` выполняет установку зависимостей, тесты, проверку синтаксиса и dry-run сборки Worker. Он не развёртывает код и не требует Cloudflare-токена.

Для production-развёртывания используйте локальный Wrangler или настройте отдельный защищённый CD workflow с GitHub Environments и минимально необходимым Cloudflare API Token.

## Официальные источники

- [Cloudflare: Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Cloudflare: Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Cloudflare: D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Cloudflare: Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- [Telegram Bot API: setWebhook](https://core.telegram.org/bots/api#setwebhook)
- [Telegram: connected business bots](https://core.telegram.org/api/bots/connected-business-bots)
