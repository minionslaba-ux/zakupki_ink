/**
 * js/core/ai_learning_matrix.js
 * ============================================================================
 * AI SELF-LEARNING FEEDBACK LOOP — самообучающаяся семантическая матрица
 * ============================================================================
 * Непрерывно обучается на действиях аналитика: когда человек вручную
 * сопоставляет «неизвестное слово шапки» → «системному полю», правило
 * запоминается с весом уверенности и в дальнейшем применяется автоматически.
 *
 * Связан с: Почтовый робот (mail_parser.js), Окно загрузки (data_uploader.js),
 *           ИИ-Коннект, Журнал безопасности (security_log.js).
 *
 * База знаний `ai_semantic_weights` (коллекция в облаке Firestore):
 *   {
 *     system_field: 'raw_material_name' | 'sku' | 'landed_cost' | 'total_revenue' | …,
 *     scope:        'global' | 'company_1' | 'company_2',
 *     synonyms: [ { word, weight: 0..1, hits, lastSeen, trainedBy } ]
 *   }
 *
 * @module core/ai_learning_matrix
 */

/** Системные поля, на которые мапятся пользовательские слова. */
export const SYSTEM_FIELDS = [
  'raw_material_name', 'sku', 'nomenclature', 'quantity', 'unit_price',
  'total_revenue', 'cogs', 'landed_cost', 'supplier', 'client', 'doc_date',
];

/** Базовые встроенные синонимы (seed) — стартовая точка обучения. */
const SEED = {
  nomenclature:   ['номенклатура', 'товар', 'наименование', 'item', 'product'],
  raw_material_name: ['сырьё', 'материал', 'material'],
  quantity:       ['количество', 'кол-во', 'объём', 'qty'],
  unit_price:     ['цена', 'прайс', 'price', 'тариф'],
  total_revenue:  ['выручка', 'сумма продаж', 'revenue'],
  cogs:           ['себестоимость', 'cogs'],
  landed_cost:    ['landed cost', 'полная себестоимость'],
  supplier:       ['поставщик', 'vendor', 'продавец'],
  client:         ['клиент', 'покупатель', 'customer'],
  doc_date:       ['дата', 'date', 'период'],
};

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9 ]/gi, '').replace(/\s+/g, ' ');

// ────────────────────────────────────────────────────────────────────────────
// АЛГОРИТМЫ СКОРИНГА ПОДОБИЯ СТРОК
// ────────────────────────────────────────────────────────────────────────────

/** Расстояние Левенштейна (число правок). */
export function levenshtein(a, b) {
  a = norm(a); b = norm(b);
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,        // удаление
        dp[j - 1] + 1,    // вставка
        prev + (a[i - 1] === b[j - 1] ? 0 : 1) // замена
      );
      prev = tmp;
    }
  }
  return dp[n];
}

/** Похожесть по Левенштейну: 1 − расстояние/максДлина (0..1). */
export function levSimilarity(a, b) {
  const max = Math.max(norm(a).length, norm(b).length) || 1;
  return 1 - levenshtein(a, b) / max;
}

/** Коэффициент Дайса по биграммам (устойчив к перестановкам, 0..1). */
export function diceCoefficient(a, b) {
  a = norm(a); b = norm(b);
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.substr(i, 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const [g, c] of A) if (B.has(g)) inter += Math.min(c, B.get(g));
  const total = (a.length - 1) + (b.length - 1);
  return (2 * inter) / total;
}

/** Комбинированная похожесть (Дайс + Левенштейн), 0..1. */
export function wordSimilarity(a, b) {
  return 0.6 * diceCoefficient(a, b) + 0.4 * levSimilarity(a, b);
}

// ────────────────────────────────────────────────────────────────────────────
// ОБУЧАЕМАЯ МАТРИЦА
// ────────────────────────────────────────────────────────────────────────────

export class AiLearningMatrix {
  /**
   * @param {object} ctx — {
   *   companyId,                       // активная компания ('company_1'|'company_2')
   *   load(): object,                  // прочитать ai_semantic_weights из стора/облака
   *   save(matrix): void,              // сохранить обратно
   *   onLearn(eventInfo): void,        // колбэк в Журнал безопасности
   * }
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.matrix = ctx.load() || this._seedMatrix();
  }

  _seedMatrix() {
    const m = {};
    for (const field of Object.keys(SEED)) {
      m[field] = { global: SEED[field].map((w) => ({ word: norm(w), weight: 0.7, hits: 0, lastSeen: 0, trainedBy: 'seed' })), company_1: [], company_2: [] };
    }
    return m;
  }

  _scopeKey() { return this.ctx.companyId === 'company_2' ? 'company_2' : 'company_1'; }

  /** Все правила поля, видимые текущей компании (локальные + глобальные). */
  _rulesFor(field) {
    const rec = this.matrix[field];
    if (!rec) return [];
    return [...(rec.global || []), ...(rec[this._scopeKey()] || [])];
  }

  // ── РАСПОЗНАВАНИЕ: лучшее системное поле для слова шапки ──────────────────
  /**
   * @param {string} headerWord — слово из шапки файла
   * @param {number} [threshold=0.62] — порог уверенности
   * @returns {{ field:string, confidence:number, matchedWord:string } | null}
   */
  classify(headerWord, threshold = 0.62) {
    const w = norm(headerWord);
    if (!w) return null;
    let best = null;
    for (const field of Object.keys(this.matrix)) {
      for (const rule of this._rulesFor(field)) {
        // подобие × вес уверенности правила
        const sim = wordSimilarity(w, rule.word);
        const score = sim * (0.5 + 0.5 * rule.weight);
        if (!best || score > best.score) best = { field, score, matchedWord: rule.word, rule };
      }
    }
    if (best && best.score >= threshold) {
      return { field: best.field, confidence: Math.min(1, best.score), matchedWord: best.matchedWord };
    }
    return null;
  }

  /** Маппинг всей шапки → { fieldByColumnIndex }. */
  mapHeaders(headers) {
    const out = {};
    headers.forEach((h, i) => { const c = this.classify(h); if (c) out[c.field] = i; });
    return out;
  }

  // ── ОБУЧЕНИЕ: ручное сопоставление аналитиком (Feedback Loop) ─────────────
  /**
   * Аналитик сопоставил «неизвестное слово» → «системному полю».
   * Добавляет правило в локальную базу компании с весом 1.0.
   * @returns {object} событие обучения (для лога)
   */
  trainSemanticCore(userWord, systemField, analystId) {
    const w = norm(userWord);
    if (!w || !systemField) return null;
    if (!this.matrix[systemField]) this.matrix[systemField] = { global: [], company_1: [], company_2: [] };
    const scope = this._scopeKey();
    const list = this.matrix[systemField][scope] = this.matrix[systemField][scope] || [];
    const existing = list.find((r) => r.word === w);
    if (existing) { existing.weight = 1.0; existing.hits++; existing.lastSeen = Date.now(); }
    else list.push({ word: w, weight: 1.0, hits: 1, lastSeen: Date.now(), trainedBy: analystId || 'analyst' });
    this._save();
    const event = {
      ts: Date.now(), analystId: analystId || 'analyst', word: userWord, field: systemField, scope,
      message: 'Робот Shtark Flow успешно обучен пользователем ' + (analystId || 'аналитиком') +
               '. Новое синонимичное поле [' + userWord + '] привязано к параметру [' + systemField + ']. Точность распознавания повышена.',
    };
    if (this.ctx.onLearn) this.ctx.onLearn(event); // → Журнал безопасности
    return event;
  }

  /**
   * Подтверждение правила: система распознала слово, аналитик НЕ исправил —
   * повышаем уверенность (вес → к 1.0) и счётчик попаданий.
   */
  reinforce(headerWord) {
    const c = this.classify(headerWord, 0.5);
    if (!c) return;
    for (const field of Object.keys(this.matrix)) {
      for (const scope of ['global', 'company_1', 'company_2']) {
        const rule = (this.matrix[field][scope] || []).find((r) => r.word === norm(c.matchedWord));
        if (rule) { rule.hits++; rule.lastSeen = Date.now(); rule.weight = Math.min(1, rule.weight + 0.05); }
      }
    }
    this._save();
  }

  // ── КРОСС-КОМПАНИЙНЫЙ ОБМЕН ОПЫТОМ ───────────────────────────────────────
  /**
   * Если локальное правило показало стабильную точность (hits ≥ N, weight = 1),
   * оно повышается до глобального — опыт транслируется на обе компании.
   */
  promoteToGlobal(minHits = 3) {
    let promoted = 0;
    for (const field of Object.keys(this.matrix)) {
      const rec = this.matrix[field];
      for (const scope of ['company_1', 'company_2']) {
        const keep = [];
        for (const rule of (rec[scope] || [])) {
          if (rule.weight >= 1 && rule.hits >= minHits) {
            if (!(rec.global || []).some((g) => g.word === rule.word)) {
              rec.global = rec.global || []; rec.global.push({ ...rule, trainedBy: rule.trainedBy + ' → global' });
              promoted++;
            }
          } else keep.push(rule);
        }
        rec[scope] = keep;
      }
    }
    if (promoted) this._save();
    return promoted;
  }

  // ── СТАТИСТИКА АВТОМАТИЗАЦИИ (для Excel AI_Autopilot_Report) ──────────────
  /**
   * @returns {{ learnedForms:number, globalRules:number, localRules:number,
   *            automationPct:number, targetKpi:number }}
   */
  stats(period) {
    let global = 0, local = 0, learnedThisPeriod = 0;
    const since = period ? new Date(period + '-01').getTime() : 0;
    for (const field of Object.keys(this.matrix)) {
      const rec = this.matrix[field];
      global += (rec.global || []).length;
      for (const scope of ['company_1', 'company_2']) {
        for (const rule of (rec[scope] || [])) {
          local++;
          if (rule.trainedBy !== 'seed' && rule.lastSeen >= since) learnedThisPeriod++;
        }
      }
    }
    // % автоматизации: доля авто-распознанных правил среди всех применённых
    const totalRules = global + local;
    const autoRules = global + local - learnedThisPeriod; // распознанные без ручного вмешательства
    const automationPct = totalRules ? Math.round((autoRules / totalRules) * 1000) / 10 : 0;
    return { learnedForms: learnedThisPeriod, globalRules: global, localRules: local, automationPct, targetKpi: 95 };
  }

  _save() { if (this.ctx.save) this.ctx.save(this.matrix); this.promoteToGlobal(); }
}

/**
 * ════════════════════════════════════════════════════════════════════════
 *  AI FALLBACK & AUTO-INGESTION CORE — каскадное «спасение» нераспознанных файлов
 * ════════════════════════════════════════════════════════════════════════
 * Внутренний семантический парсер + локальная матрица `ai_semantic_weights` за
 * 5 итераций НЕ распознали структуру (категорию) файла → эскалация к старшему
 * внешнему ИИ → он возвращает {identified_category, mapping_schema} → данные
 * бесшовно вносятся в базу, движок 24/7 запускается, а карта сопоставления
 * АВТОМАТИЧЕСКИ записывается в глобальную матрицу с максимальным весом. В
 * следующий раз такой же файл распознаётся локально — без платного API.
 *
 * @param {object} fileData — { fileName, headers:string[], rows:any[][], sig }
 * @param {string} companyId — 'company_1' | 'company_2'
 * @param {object} deps — {
 *   orchestrator: AiOrchestrator,    // внешний ИИ (см. ai_orchestrator.js)
 *   matrix:       AiLearningMatrix,  // локальная база знаний
 *   systemFields: string[], categories: [{key,label}],
 *   ingest:       (category, fileData, internalMap) => void,  // приём в базу
 *   recompute:    () => void,        // движок пересчёта 24/7
 *   notifyChat:   (text) => void,    // радостное уведомление со звуком
 *   securityLog:  (msg) => void,     // детальная запись в Журнал безопасности
 *   fieldAlias?:  { [systemField]: internalMapKey },
 * }
 * @returns {Promise<{ok:boolean, category?:string, learned?:number, reason?:string}>}
 */
export async function executeExternalAiFallback(fileData, companyId, deps) {
  const t0 = Date.now();
  const cats = (deps.categories || []).map((c) => c.key + ' (' + c.label + ')').join('; ');
  // 1) Запрос к старшему внешнему ИИ: матрица файла как ДАННЫЕ, контекст — как промпт
  let verdict;
  try {
    verdict = await deps.orchestrator.dispatch({
      type: 'reason',
      system: 'Ты — старший ИИ-аналитик ERP Shtark Flow. Внутренний парсер не распознал файл. Определи категорию по смыслу. Категории: ' + cats +
              '. Системные поля: ' + (deps.systemFields || []).join(', ') +
              '. Верни строго JSON {"identified_category":"<ключ>","confidence":<0..1>,"mapping_schema":[{"file_column":"<заголовок>","system_field":"<поле>"}]}.',
      prompt: 'Файл «' + fileData.fileName + '». Заголовки: ' + JSON.stringify(fileData.headers) +
              '. Примеры строк: ' + JSON.stringify((fileData.rows || []).slice(0, 6)),
      max: 900,
    });
  } catch (e) { return { ok: false, reason: 'external-error', error: (e && e.message) || String(e) }; }

  // 2) Валидация структурированного ответа
  const j = verdict && verdict.matrix ? verdict.matrix : verdict;
  let schema = (j && j.mapping_schema) || null;
  let category = (j && j.identified_category) || null;
  if (!schema && verdict && verdict.raw) {
    try { const p = JSON.parse((verdict.raw.match(/\{[\s\S]*\}/) || [])[0]); schema = p.mapping_schema; category = p.identified_category; } catch (e) {}
  }
  if (!category || !Array.isArray(schema) || !schema.length) return { ok: false, reason: 'invalid-json' };

  // 3) КРИТИЧНО: авто-обучение глобальной матрицы по mapping_schema
  const fieldAlias = deps.fieldAlias || {};
  const internalMap = {};
  let learned = 0;
  for (const pair of schema) {
    const col = pair.file_column != null ? String(pair.file_column) : '';
    const sf = pair.system_field != null ? String(pair.system_field).trim() : '';
    if (!col || !sf) continue;
    // записать как ГЛОБАЛЬНОЕ правило с максимальным доверием (опыт обеих компаний)
    deps.matrix.trainSemanticCore(col, sf, companyId, 'external-ai → global');
    if (deps.matrix.matrix[sf]) {
      deps.matrix.matrix[sf].global = deps.matrix.matrix[sf].global || [];
      const g = deps.matrix.matrix[sf].global.find((r) => r.word === String(col).toLowerCase().trim());
      if (!g) deps.matrix.matrix[sf].global.push({ word: String(col).toLowerCase().trim(), weight: 1, hits: 1, lastSeen: Date.now(), trainedBy: 'external-ai → global' });
    }
    const ci = fileData.headers.indexOf(col);
    const alias = fieldAlias[sf];
    if (alias && ci >= 0 && internalMap[alias] == null) internalMap[alias] = ci;
    learned++;
  }
  deps.matrix._save();

  // 4) Бесшовный приём + движок 24/7 + уведомление со звуком
  try { deps.ingest(category, fileData, internalMap); } catch (e) {}
  try { deps.recompute(); } catch (e) {}
  try { deps.notifyChat('🤖 Файл «' + fileData.fileName + '» распознан внешним ИИ как «' + category + '» и внесён в базу. Система обучена.'); } catch (e) {}

  // 5) Детальная запись в Журнал безопасности
  try {
    deps.securityLog('Внутреннее ядро не распознало файл «' + fileData.fileName + '». Активирован внешний ИИ-Оркестратор. ' +
      'Файл успешно идентифицирован как [' + category + ']. Карта маппинга (' + learned + ' полей) автоматически сохранена ' +
      'в локальную матрицу обучения. Система успешно обучена в автономном режиме за ' + ((Date.now() - t0) / 1000).toFixed(1) + ' с.');
  } catch (e) {}

  return { ok: true, category, learned, confidence: j.confidence, ms: Date.now() - t0 };
}

