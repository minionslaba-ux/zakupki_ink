# Shtark Flow — Деплой, безопасность ключей и сохранность боевых данных

Документ закрывает два финальных требования ТЗ:
1. **Мульти-ИИ оркестрация через внешние API** (`js/core/ai_orchestrator.js`).
2. **Абсолютная защита боевых данных при деплое на GitHub Pages** (разделение кода и данных).

---

## 1. Архитектурная схема: разделение кода и данных

```
                       ┌──────────────────────────────────────────────┐
                       │              ИСТОЧНИК ИСТИНЫ ДАННЫХ            │
                       │   (НЕ в репозитории — переживает любой деплой) │
                       │                                                │
                       │   Firebase / Supabase           Cloud Storage  │
                       │   ┌───────────────────┐    ┌─────────────────┐ │
                       │   │ архив файлов (idx) │    │ оригиналы файлов│ │
                       │   │ логи безопасности  │    │ PDF / xlsx / img│ │
                       │   │ задачи, чаты, KPI  │    └─────────────────┘ │
                       │   │ маппинг-шаблоны    │                        │
                       │   │ настройки админа   │                        │
                       │   │ ai-провайдеры/ключи│                        │
                       │   └─────────┬─────────┘                        │
                       └─────────────┼──────────────────────────────────┘
                                     │ read/write 24/7 (онлайн-слой)
                                     ▼
   ┌──────────────────────── GitHub Pages (СТАТИКА) ───────────────────────┐
   │  Только КОД и СТИЛИ — перезаписывается при каждом git push:            │
   │   index.html · *.dc.html · support.js · js/**/*.js · Tailwind/CSS      │
   │   (никаких .json с боевыми данными, никаких ключей)                    │
   │                              │                                         │
   │                              ▼                                         │
   │                     [ Браузер пользователя ]                           │
   │                              │                                         │
   │          ┌───────────────────┼────────────────────┐                   │
   │          ▼                   ▼                    ▼                    │
   │   Firebase SDK        AiOrchestrator        Serverless-прокси          │
   │   (данные)            .dispatch()           /api/ai · /api/ocr         │
   └───────────────────────────────────────────────────┼───────────────────┘
                                                         ▼
                       ┌─────────────────────────────────────────────────┐
                       │  ВНЕШНИЕ ИИ (ключи в Environment Variables):      │
                       │  OpenAI · Anthropic Claude · DeepSeek · OCR       │
                       └─────────────────────────────────────────────────┘
```

**Принцип:** `git push` обновляет **только левую коробку** (статический фронтенд). Вся
правая часть (данные + ключи) живёт во внешнем облаке и `push`-ем не затрагивается.

---

## 2. Мульти-ИИ оркестратор: как это работает

Модуль `AiOrchestrator` (`js/core/ai_orchestrator.js`) — единая точка вызова внешних
нейросетей. Внутренний движок 24/7 сначала пытается решить задачу сам; во внешний ИИ
эскалирует **только сложные** случаи (порог сложности настраивается).

```js
import { AiOrchestrator } from './js/core/ai_orchestrator.js';

// Ключи приходят из облачной конфигурации админа (Firebase), НЕ из репозитория.
const ai = new AiOrchestrator({
  defaultProvider: 'proxy',                 // безопасный режим: ключ держит сервер
  complexityThreshold: 0.6,
  providers: {
    proxy:     { base: '/api/ai', keyless: true, enabled: true },   // прод
    anthropic: { key: cloudCfg.keys?.anthropic, enabled: false },   // только админ/локально
    openai:    { key: cloudCfg.keys?.openai,    enabled: false },
    deepseek:  { key: cloudCfg.keys?.deepseek,  enabled: false },
    ocr:       { base: '/api/ocr', keyless: true, enabled: true },
  },
  onLog: (evt) => app.secLog && app.secLog('SELF_LEARN', { detail: 'AI ' + evt.kind }),
});

// Пример: обнаружена сложная многофакторная аномалия оверхеда логистики
const anomalyMatrix = {
  contour: 'Закупки/логистика',
  factors: ['price', 'logistics', 'fx', 'storage'],   // 4 фактора → многофакторность
  nonlinear: true,                                    // нелинейный скачок
  crossModule: true,                                  // затрагивает Доставку и P&L
  deviationPct: 42,
  batch: '0744',
  data: { plan: 250000, fact: 408000, logiPerUnit: 211, dirAvg: 150 },
};

if (ai.shouldEscalate(anomalyMatrix)) {
  const verdict = await ai.escalateAnomaly(anomalyMatrix);
  // verdict = { ok, summary, growth_points:[{action, effect_eur}], risk_score, matrix, provider, model }
  renderVerdict(verdict);          // бесшовно в интерфейс
  exportVerdictToExcel(verdict);   // и в Excel (xlsx-js-style / openpyxl-совместимый лист)
}
```

Ключевые свойства: **timeout + retry + fallback** по цепочке провайдеров,
**нормализация** ответа (JSON / ```-блок / свободный текст → единый объект),
маршрутизация по классу задачи (`reason` / `score` / `ocr`).

### Серверless-прокси (production-безопасно)

Чтобы ключ **не попал в браузер**, фронтенд зовёт собственную функцию `/api/ai`,
которая на сервере подставляет ключ из Environment Variable и проксирует запрос.

```js
// Cloudflare Worker / Vercel Edge / Netlify Function — пример (OpenAI-совместимый вход)
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const payload = await request.json();
    // ключ берётся из секретов окружения — НИКОГДА из тела запроса и не из репозитория
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,        // ← Environment Variable
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(payload),
    });
    return new Response(upstream.body, { status: upstream.status, headers: { 'content-type': 'application/json' } });
  },
};
```

> GitHub Pages отдаёт только статику и не умеет серверных функций. Прокси разворачивается
> рядом — на Cloudflare Workers / Vercel / Netlify — и доступен по своему URL
> (`https://api.shtarkflow.ru/ai`), который указывается в `providers.proxy.base`.

---

## 3. Environment Variables / GitHub Secrets — чтобы ключи не утекли

**Золотое правило:** ни один ключ или строка подключения к БД не коммитится в репозиторий.
В коде нет ключей — только ссылки на серверless-прокси и на публичный (безопасный для
клиента) конфиг Firebase.

### 3.1. Где лежат секреты

| Секрет | Где хранится | Кто читает |
|---|---|---|
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `OCR_API_KEY` | Env Vars прокси (Cloudflare/Vercel/Netlify) | только серверless-функция |
| `FIREBASE_*` (admin/service-account, если нужен серверный доступ) | GitHub Secrets / Env Vars прокси | CI и серверная часть |
| Firebase **web config** (apiKey клиента) | можно в коде — это НЕ секрет, доступ ограничивают **Security Rules** | браузер |
| Ключи, введённые админом в панели | Firebase, на аккаунт админа (с правилами доступа) | только админ |

### 3.2. Настройка GitHub Secrets (Settings → Secrets and variables → Actions)

```
ANTHROPIC_API_KEY = sk-ant-...
OPENAI_API_KEY    = sk-...
DEEPSEEK_API_KEY  = sk-...
OCR_API_KEY       = ...
FIREBASE_SA_JSON  = { ... service account ... }   # если используется серверный SDK
```

Эти значения доступны только в GitHub Actions (CI) и в окружении прокси — в собранную
статику они **не** попадают.

### 3.3. Настройка Env Vars у прокси

- **Cloudflare Workers:** `wrangler secret put ANTHROPIC_API_KEY` (или Dashboard → Settings → Variables → Encrypt).
- **Vercel:** Project → Settings → Environment Variables → добавить, scope = Production.
- **Netlify:** Site settings → Environment variables.

### 3.4. `.gitignore` — что никогда не коммитим

```
.env
.env.*
**/secrets*.json
**/serviceAccount*.json
firebase-admin*.json
```

### 3.5. Локальная разработка

Положите ключи в `.env` (он в `.gitignore`) и читайте их только в серверной/прокси-части.
Фронтенд в dev-режиме ходит на локальный прокси `http://localhost:8787/ai`.

---

## 4. Гарантия сохранности при `git push` (чек-лист деплоя)

- [ ] В репозитории **нет** боевых `.json` с данными (задачи, чаты, KPI, логи, маппинг).
- [ ] В коде **нет** API-ключей и приватных строк подключения (только web-config Firebase + URL прокси).
- [ ] Включены **Firebase Security Rules** (доступ к данным — только аутентифицированным, по ролям).
- [ ] Боевые данные пишутся в облако (Firebase) и в Cloud Storage — приложение при старте
      читает облако как источник истины, а локальные демо-данные служат лишь фолбэком при первом запуске.
- [ ] Внешние ИИ вызываются через `/api/ai` (прокси с Env Vars) либо ключом админа из облака.
- [ ] `git push` нового фронтенда **не трогает** ни одну запись данных — проверяется тем,
      что после деплоя архив файлов, логи и настройки админа на месте.

> Итог: обновление интерфейса (Tailwind/скрипты) на GitHub Pages безопасно в режиме 24/7 —
> боевая база и кастомные настройки администратора остаются в 100% сохранности.
