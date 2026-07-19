/**
 * js/core/ai_orchestrator.js
 * ============================================================================
 * МУЛЬТИ-ИИ ОРКЕСТРАТОР (External API Gateway)
 * ============================================================================
 * Привлекает внешние специализированные нейросети для сверхглубокого анализа,
 * когда внутренний детерминированный движок упирается в сложную многофакторную
 * аномалию (нелинейный скачок оверхеда, запутанная кастомная форма, скоринг
 * риска кассового разрыва) или в нечитаемый PDF-скан.
 *
 * ┌──────────────────────────── АРХИТЕКТУРНАЯ СХЕМА ───────────────────────────┐
 * │                                                                            │
 * │  [Движок 24/7]            [Окно загрузки]          [Доставка / P&L]         │
 * │   executeDeepBI()          dlReadPdf()              cashGapInfo()           │
 * │        │                       │                        │                  │
 * │        ▼  complexity>=порог    ▼  textLayer пуст        ▼  риск>=порог       │
 * │   ┌────┴───────────────────────┴────────────────────────┴────┐             │
 * │   │            AiOrchestrator.dispatch(task)                  │  ← единая   │
 * │   │  • выбор провайдера по типу задачи (reason / ocr / score) │    точка    │
 * │   │  • нормализация запроса → провайдер-специфичный payload   │    входа    │
 * │   │  • timeout + retry + fallback по цепочке провайдеров      │             │
 * │   └────┬───────────────┬───────────────┬──────────────┬──────┘             │
 * │        ▼               ▼               ▼              ▼                     │
 * │   OpenAI GPT     Anthropic Claude   DeepSeek     OCR-сервис                 │
 * │   /chat/compl.   /v1/messages       /chat/compl. (Vision/Tesseract API)     │
 * │        └───────────────┴───────────────┴──────────────┘                    │
 * │                            │ verdict (JSON)                                 │
 * │                            ▼                                                │
 * │              normalizeVerdict() → единый формат                            │
 * │            { summary, growth_points[], risk_score, matrix }                 │
 * │                            │                                                │
 * │          ┌─────────────────┼─────────────────┐                             │
 * │          ▼                 ▼                 ▼                              │
 * │     UI (вердикт)     Excel (openpyxl /   Журнал/чат                         │
 * │                       xlsx-js-style)                                        │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * БЕЗОПАСНОСТЬ КЛЮЧЕЙ: ключи НИКОГДА не хранятся в коде репозитория.
 *   • Прод-режим (рекомендуется): фронтенд зовёт СОБСТВЕННЫЙ серверless-прокси
 *     (Cloudflare Worker / Vercel / Netlify Function), который держит ключ в
 *     Environment Variables. Браузер ключа не видит. baseUrl = '/api/ai'.
 *   • Локальный/админский режим: ключ вводит администратор в защищённой панели,
 *     хранится в облаке (Firebase) на аккаунт админа, НЕ в localStorage и НЕ в git.
 *   Подробно — см. DEPLOY.md (раздел «Environment Variables / GitHub Secrets»).
 *
 * @module core/ai_orchestrator
 */

/** Реестр провайдеров. type: 'openai-compatible' | 'anthropic' | 'ocr'. */
export const AI_PROVIDERS = {
  proxy:     { label: 'Серверless-прокси (безопасно)', type: 'openai-compatible', base: '/api/ai',                       model: 'auto',                    keyless: true },
  openai:    { label: 'OpenAI GPT',                     type: 'openai-compatible', base: 'https://api.openai.com/v1',     model: 'gpt-4o' },
  anthropic: { label: 'Anthropic Claude',              type: 'anthropic',         base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-20250514', version: '2023-06-01' },
  deepseek:  { label: 'DeepSeek',                       type: 'openai-compatible', base: 'https://api.deepseek.com',      model: 'deepseek-chat' },
  openrouter:{ label: 'OpenRouter (агрегатор)',         type: 'openai-compatible', base: 'https://openrouter.ai/api/v1',  model: 'deepseek/deepseek-chat-v3.1:free' },
  ocr:       { label: 'OCR-сервис (Vision)',            type: 'ocr',               base: '/api/ocr',                     model: 'document' },
};

/** Какой провайдер предпочесть под класс задачи (с цепочкой fallback). */
export const TASK_ROUTING = {
  reason: ['proxy', 'anthropic', 'openai', 'deepseek', 'openrouter'], // глубокий аналитический аудит
  score:  ['proxy', 'openai', 'deepseek', 'anthropic', 'openrouter'], // скоринг рисков (структурный JSON)
  ocr:    ['ocr', 'proxy', 'anthropic', 'openai'],                    // распознавание PDF-скана/матрицы
};

const DEFAULT_TIMEOUT = 45000;

export class AiOrchestrator {
  /**
   * @param {object} cfg — {
   *   providers: { [name]: { key?, base?, model?, enabled? } },  // оверрайды + ключи (из облака/прокси)
   *   defaultProvider?: string,
   *   onLog?: (evt) => void,            // лог в Журнал безопасности / системные заметки
   *   complexityThreshold?: number,     // 0..1, выше — эскалируем во внешний ИИ (по умолчанию .6)
   *   fetchImpl?: typeof fetch,
   * }
   */
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.providers = { ...AI_PROVIDERS };
    for (const name in (cfg.providers || {})) this.providers[name] = { ...this.providers[name], ...cfg.providers[name] };
    this.complexityThreshold = cfg.complexityThreshold != null ? cfg.complexityThreshold : 0.6;
    this._fetch = cfg.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
  }

  _log(evt) { try { if (this.cfg.onLog) this.cfg.onLog(evt); } catch (e) {} }
  _enabled(name) { const p = this.providers[name]; return !!p && p.enabled !== false && (p.keyless || p.key); }

  /** Доступная цепочка провайдеров под класс задачи. */
  chainFor(taskType) {
    const order = TASK_ROUTING[taskType] || TASK_ROUTING.reason;
    const pref = this.cfg.defaultProvider;
    const list = (pref && this._enabled(pref)) ? [pref, ...order.filter(n => n !== pref)] : order;
    return list.filter(n => this._enabled(n));
  }

  // ── ОЦЕНКА СЛОЖНОСТИ: нужно ли вообще звать внешний ИИ ────────────────────
  /**
   * Эвристический скоринг сложности аномалии 0..1. Чем выше — тем нужнее
   * сверхглубокий внешний аудит. >= complexityThreshold → эскалируем.
   * @param {object} anomalyMatrix — нормализованная матрица аномалии
   */
  assessComplexity(anomalyMatrix = {}) {
    let s = 0;
    const f = anomalyMatrix.factors || [];
    if (f.length >= 3) s += 0.35;                                  // многофакторность
    if (anomalyMatrix.nonlinear) s += 0.25;                        // нелинейный скачок
    if (anomalyMatrix.crossModule) s += 0.2;                       // затрагивает >1 контур
    if (Math.abs(anomalyMatrix.deviationPct || 0) > 25) s += 0.15; // крупное отклонение
    if (anomalyMatrix.unstructured) s += 0.3;                      // запутанная форма / скан
    return Math.min(1, s);
  }

  shouldEscalate(anomalyMatrix) { return this.assessComplexity(anomalyMatrix) >= this.complexityThreshold; }

  // ── ГЛАВНЫЙ ВХОД: маршрутизация задачи к внешнему ИИ ──────────────────────
  /**
   * @param {object} task — {
   *   type: 'reason'|'score'|'ocr',
   *   system?: string, prompt?: string,
   *   matrix?: object,              // JSON-матрица аномалии (передаётся как данные)
   *   image?: string,              // base64/URL для OCR
   *   max?: number, timeout?: number,
   * }
   * @returns {Promise<object>} нормализованный вердикт
   */
  async dispatch(task) {
    if (!this._fetch) throw new Error('fetch недоступен в этой среде');
    const chain = this.chainFor(task.type || 'reason');
    if (!chain.length) throw new Error('Нет настроенных внешних ИИ-провайдеров (укажите ключ или включите серверless-прокси).');
    let lastErr = '';
    for (const name of chain) {
      const p = this.providers[name];
      const t0 = Date.now();
      try {
        const raw = (p.type === 'ocr')
          ? await this._callOcr(p, task)
          : (p.type === 'anthropic')
            ? await this._callAnthropic(p, task)
            : await this._callOpenAICompatible(p, task);
        const verdict = this.normalizeVerdict(raw, { provider: name, model: p.model, ms: Date.now() - t0 });
        this._log({ kind: 'ai_dispatch_ok', provider: name, type: task.type, ms: Date.now() - t0 });
        return verdict;
      } catch (e) {
        lastErr = (e && e.message) || String(e);
        this._log({ kind: 'ai_dispatch_fail', provider: name, error: lastErr });
        // auth/credit-ошибки конкретного провайдера → пробуем следующий в цепочке
      }
    }
    throw new Error('Все внешние ИИ-провайдеры недоступны: ' + lastErr);
  }

  _timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms || DEFAULT_TIMEOUT)); }
  async _race(p, ms) { return Promise.race([p, this._timeout(ms)]); }

  // ── ВЫЗОВ: OpenAI-совместимый (OpenAI / DeepSeek / OpenRouter / прокси) ────
  async _callOpenAICompatible(p, task) {
    const base = String(p.base || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers['Authorization'] = 'Bearer ' + p.key;          // прокси сам подставит ключ на сервере
    try { headers['HTTP-Referer'] = location.origin; headers['X-Title'] = 'Shtark Flow'; } catch (e) {}
    const messages = this._buildMessages(task);
    const body = { model: p.model && p.model !== 'auto' ? p.model : undefined, messages, max_tokens: task.max || 1100, temperature: task.temperature ?? 0.2 };
    const r = await this._race(this._fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) }), task.timeout);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && (d.error.message || JSON.stringify(d.error))) || ('HTTP ' + r.status));
    return (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '';
  }

  // ── ВЫЗОВ: Anthropic Claude (формат /v1/messages отличается) ──────────────
  async _callAnthropic(p, task) {
    const base = String(p.base || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': p.version || '2023-06-01' };
    if (p.key) headers['x-api-key'] = p.key;
    // browser-доступ к Anthropic требует CORS-флага (или, что правильнее, серверless-прокси)
    try { headers['anthropic-dangerous-direct-browser-access'] = 'true'; } catch (e) {}
    const sys = task.system || 'Ты — главный финансовый аналитик ERP-системы. Отвечай строго по делу, числами и фактами.';
    const userContent = this._userPayload(task);
    const body = { model: p.model, max_tokens: task.max || 1100, system: sys, messages: [{ role: 'user', content: userContent }] };
    const r = await this._race(this._fetch(base + '/messages', { method: 'POST', headers, body: JSON.stringify(body) }), task.timeout);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && (d.error.message || JSON.stringify(d.error))) || ('HTTP ' + r.status));
    return (d.content && d.content[0] && d.content[0].text) || '';
  }

  // ── ВЫЗОВ: OCR-сервис (распознавание PDF-скана / матрицы) ─────────────────
  async _callOcr(p, task) {
    const base = String(p.base || '').replace(/\/+$/, '');
    const headers = { 'Content-Type': 'application/json' };
    if (p.key) headers['Authorization'] = 'Bearer ' + p.key;
    const body = { model: p.model || 'document', image: task.image, hint: task.prompt || 'Извлеки табличные данные: заголовки и строки.' };
    const r = await this._race(this._fetch(base + '/recognize', { method: 'POST', headers, body: JSON.stringify(body) }), task.timeout || 60000);
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && (d.error.message || JSON.stringify(d.error))) || ('OCR HTTP ' + r.status));
    return d; // { headers:[], rows:[[]] } или { text }
  }

  // ── Сборка сообщений: матрица аномалии передаётся как ДАННЫЕ, не инструкция
  _buildMessages(task) {
    const sys = task.system || 'Ты — главный финансовый аналитик ERP-системы Shtark Flow. Проводишь сверхглубокий аудит. Возвращай СТРОГО JSON по схеме {"summary":string,"growth_points":[{"action":string,"effect_eur":number}],"risk_score":number,"matrix":object}. Никакого текста вне JSON.';
    return [{ role: 'system', content: sys }, { role: 'user', content: this._userPayload(task) }];
  }
  _userPayload(task) {
    let s = task.prompt ? (task.prompt + '\n\n') : '';
    if (task.matrix) s += '=== JSON-МАТРИЦА АНОМАЛИИ (данные для анализа) ===\n' + JSON.stringify(task.matrix, null, 1);
    return s || 'Проанализируй приложенные данные.';
  }

  // ── НОРМАЛИЗАЦИЯ ВЕРДИКТА: единый формат для UI и Excel ───────────────────
  /**
   * Внешний ИИ может вернуть JSON-строку, JSON в ```-блоке или свободный текст.
   * Возвращаем единый объект, который бесшовно ложится в интерфейс и openpyxl.
   */
  normalizeVerdict(raw, meta = {}) {
    if (raw && typeof raw === 'object' && (raw.headers || raw.rows || raw.text)) {
      // ответ OCR
      return { ok: true, kind: 'ocr', headers: raw.headers || [], rows: raw.rows || [], text: raw.text || '', provider: meta.provider, model: meta.model, ms: meta.ms };
    }
    const text = String(raw || '').trim();
    let json = null;
    const m = text.match(/```(?:json)?\s*([\s\S]*?)```/i) || text.match(/(\{[\s\S]*\})/);
    if (m) { try { json = JSON.parse(m[1]); } catch (e) {} }
    if (!json && /^\s*\{/.test(text)) { try { json = JSON.parse(text); } catch (e) {} }
    if (json) {
      return {
        ok: true, kind: 'verdict',
        summary: json.summary || json.verdict || '',
        growth_points: Array.isArray(json.growth_points) ? json.growth_points : [],
        risk_score: typeof json.risk_score === 'number' ? json.risk_score : null,
        matrix: json.matrix || null,
        raw: text, provider: meta.provider, model: meta.model, ms: meta.ms,
      };
    }
    // свободный текст — оборачиваем как summary
    return { ok: true, kind: 'text', summary: text, growth_points: [], risk_score: null, matrix: null, raw: text, provider: meta.provider, model: meta.model, ms: meta.ms };
  }

  // ── ВЫСОКОУРОВНЕВЫЕ ХЕЛПЕРЫ ───────────────────────────────────────────────
  /** Эскалировать аномалию во внешний ИИ, но ТОЛЬКО если она достаточно сложна. */
  async escalateAnomaly(anomalyMatrix, opts = {}) {
    if (!this.shouldEscalate(anomalyMatrix) && !opts.force) {
      return { ok: false, skipped: true, reason: 'низкая сложность — обработано внутренним движком', complexity: this.assessComplexity(anomalyMatrix) };
    }
    return this.dispatch({
      type: 'reason',
      system: opts.system,
      prompt: opts.prompt || 'Проведи сверхглубокий причинно-следственный аудит этой аномалии. Дай первопричину, скоринг риска (0..1) и ранжированные точки роста с эффектом в евро.',
      matrix: anomalyMatrix, max: opts.max || 1200, timeout: opts.timeout,
    });
  }
  /** Скоринг риска кассового разрыва (структурный JSON-вердикт). */
  async scoreCashGapRisk(cashMatrix, opts = {}) {
    return this.dispatch({ type: 'score', prompt: 'Оцени риск кассового разрыва по горизонту. Верни JSON {risk_score, summary, growth_points}.', matrix: cashMatrix, max: opts.max || 700 });
  }
  /** Распознать матрицу PDF-скана через OCR-сервис. */
  async recognizeScan(imageBase64, hint) {
    return this.dispatch({ type: 'ocr', image: imageBase64, prompt: hint, timeout: 60000 });
  }
}

/**
 * Фабрика, удобная для встраивания в основное приложение.
 * Ключи берём из облачной конфигурации администратора (Firebase), НЕ из репозитория.
 */
export function createOrchestratorFromCloudConfig(cloudCfg = {}, hooks = {}) {
  // cloudCfg.aiProviders — объект, синхронизируемый из Firebase на аккаунт админа
  return new AiOrchestrator({
    providers: cloudCfg.aiProviders || {},
    defaultProvider: cloudCfg.defaultAiProvider || (cloudCfg.aiProviders && cloudCfg.aiProviders.proxy ? 'proxy' : undefined),
    complexityThreshold: cloudCfg.aiComplexityThreshold,
    onLog: hooks.onLog,
  });
}
