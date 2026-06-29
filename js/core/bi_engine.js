/**
 * js/core/bi_engine.js
 * ============================================================================
 * ГЛОБАЛЬНЫЙ АСИНХРОННЫЙ КОНТРОЛЛЕР СКВОЗНОГО ПЕРЕРАСЧЁТА (Deep BI Engine)
 * ============================================================================
 * Сердце ERP/BI-системы Shtark Flow. Превращает разрозненные изменения данных
 * (загрузка 1С, правка планов, ползунки курсов, чат, задачи) в строго
 * упорядоченный каскад пересчёта зависимых финансовых и логистических метрик.
 *
 * ДВИЖЕНИЕ ФИНАНСОВЫХ ПОТОКОВ (каскад, строго последовательно):
 *
 *   [1] Курсы ЦБ / Биржа        — кросс-курсы RUB↔EUR↔CNY на даты операций
 *        │                         (оприходование / выпуск / отгрузка), контур НДС
 *        ▼
 *   [2] Landed Cost (Закупки)   — полная себестоимость партии сырья в RUB:
 *        │                         инвойс·курс + логистика + таможня + брокер
 *        ▼
 *   [3] Себестоимость 1 кг      — декомпозиция Недельного плана по дням;
 *       (Производство)            ПАРТИОННЫЙ учёт (Компания №1) ИЛИ FIFO (Компания №2)
 *        ▼
 *   [4] Маржа GM1 / GM2          — выручка по курсу отгрузки − СС по курсу выпуска;
 *       (Продажи)                 очистка НДС; удельные ₽/кг и €/кг
 *        ▼
 *   [5] Баланс «Доставка»        — Остаток(T) = Остаток(T−1) + Приход(T) − Потребность(T);
 *        │                         красный уровень → авто-задача логисту
 *        ▼
 *   [6] KPI / Рейтинг ★          — звёзды по квантилям, ИИ-премии ТОП-3
 *
 * ЗАЩИТА: жёсткий guard от бесконечных циклов + очередь отложенного запуска,
 * Debounce 300 мс для фонового потока 24/7, async/await против race conditions.
 *
 * Зависит от: currency_engine.js, analytics_engine.js, autopilot.js, recalc_graph.js
 * @module core/bi_engine
 */

import { RECALC_GRAPH, EVENT_ENTRY_MAP, eventLabel } from './recalc_graph.js';
import { recomputeCrossRates } from './currency_engine.js';
import { recomputeLandedCost, recomputeCostPerKg, recomputeMargin } from './analytics_engine.js';
import { recomputeDeliveryBalance, recomputeKpiRatings } from './analytics_engine.js';
import { runAutopilotContours } from './autopilot.js';
import { showToast } from '../ui/toast.js';
import { setLoaderStep, clearLoader } from '../ui/loader.js';

/**
 * Контроллер пересчёта. Один экземпляр на приложение.
 * Хранит состояние конкурентности (не данные — данные живут в store.js).
 */
export class BiEngine {
  /** @param {import('../data/store.js').Store} store — глобальное состояние приложения */
  constructor(store) {
    this.store = store;
    this._running = false;        // активен ли каскад прямо сейчас (anti-recursion)
    this._queued = null;          // отложенный запуск, если пришёл во время работы
    this._debounceTimers = {};    // таймеры debounce по ключу
    this._pendingEvents = new Set(); // коалесцируемые события фонового потока 24/7
    this._autoBusy = false;       // guard оркестратора автопилота
  }

  // ───────────────────────────────────────────────────────────────────────
  // УТИЛИТЫ СТАБИЛИЗАЦИИ
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Debounce: откладывает вызов fn на ms; повторные вызовы с тем же key
   * сбрасывают таймер. Гасит «миллионы микро-запросов» при перетаскивании
   * ползунка стресс-теста или быстром вводе в задачах.
   */
  debounce(key, fn, ms = 300) {
    clearTimeout(this._debounceTimers[key]);
    this._debounceTimers[key] = setTimeout(() => {
      delete this._debounceTimers[key];
      try { fn(); } catch (e) { console.error('[bi_engine] debounce', e); }
    }, ms);
  }

  /** Пауза (для пошагового лоадера). */
  delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /** Уступка потока между слоями — UI остаётся отзывчивым, слои изолированы. */
  nextTick() {
    return new Promise((r) => (typeof queueMicrotask === 'function' ? queueMicrotask(r) : setTimeout(r, 0)));
  }

  // ───────────────────────────────────────────────────────────────────────
  // КОНТУР А — АВТОНОМНЫЙ ФОНОВЫЙ ПЕРЕСЧЁТ 24/7
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Точка входа для ЛЮБОГО микро-изменения данных (чат, задачи, планы,
   * ползунки, фоновая подгрузка файлов). Коалесцирует события и запускает
   * один каскад через 300 мс тишины.
   * @param {string} event — тип события (см. EVENT_ENTRY_MAP)
   */
  scheduleAutoRecalc(event) {
    if (this.store.get('autoRecalc') === false) return; // фоновый режим можно выключить
    this._pendingEvents.add(event || 'FULL_RECALC');
    this.debounce('autoRecalc', () => {
      const events = [...this._pendingEvents];
      this._pendingEvents.clear();
      if (!events.length) return;
      // берём самый «верхний» по цепочке вход — чтобы пересчитать максимум зависимостей
      const entry = this._highestEntry(events);
      this.executeDeepBusinessIntelligence(entry, { mode: 'auto', events });
    }, 300);
  }

  /** Самый ранний по каскаду вход среди коалесцированных событий. */
  _highestEntry(events) {
    const rank = { rates: 0, purchases: 1, production: 2, delivery: 3, sales: 4, finance: 5, kpi: 6 };
    let best = 'kpi', bestRank = 99;
    for (const ev of events) {
      const node = EVENT_ENTRY_MAP[ev] || 'purchases';
      const r = rank[node] ?? 9;
      if (r < bestRank) { bestRank = r; best = node; }
    }
    return best;
  }

  // ───────────────────────────────────────────────────────────────────────
  // ГЛАВНЫЙ КОНТРОЛЛЕР — executeDeepBusinessIntelligence(event, data)
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Запускает строго последовательный каскад пересчёта.
   *
   * @param {string} event — входной узел графа ('rates'|'purchases'|…) либо
   *                          событие из EVENT_ENTRY_MAP ('NEW_LANDED_COST' и т.п.)
   * @param {object} [data] — { mode:'auto'|'force', events:string[] }
   * @returns {Promise<object|null>} summary прогона (для журнала) либо null,
   *          если каскад уже выполняется (запрос поставлен в очередь).
   *
   * ЗАЩИТА ОТ БЕСКОНЕЧНЫХ ЦИКЛОВ:
   *   - флаг _running не даёт повторно войти в каскад рекурсивно;
   *   - запрос, пришедший во время работы, не вызывает рекурсию, а кладётся
   *     в _queued и выполняется ОДИН раз после завершения (idempotent-эффекты
   *     вроде авто-задач по дефициту сами гасят дальнейшие итерации).
   */
  async executeDeepBusinessIntelligence(event, data = {}) {
    // нормализуем событие → узел графа
    const entry = RECALC_GRAPH[event] ? event : (EVENT_ENTRY_MAP[event] || 'purchases');

    // ── Anti-recursion: если каскад уже идёт — откладываем, НЕ рекурсим
    if (this._running) {
      this._queued = { event: entry, data };
      return null;
    }
    this._running = true;

    let summary = null;
    try {
      // Обход графа в ширину по зависимостям → упорядоченный список слоёв без дублей
      const order = this._topoOrder(entry);
      const reportsTouched = [];
      const effectsRun = [];

      // ── Строгая последовательность слоёв (async/await против race conditions):
      //    слой Продаж НЕ стартует, пока слой Закупок не сформировал Landed Cost.
      for (const node of order) {
        await this._runLayer(node, { reportsTouched, effectsRun, mode: data.mode });
        await this.nextTick(); // изоляция слоёв + отзывчивость UI
      }

      // ── ИИ-Автопилот: автозакупки дефицитов + HR-трекинг после каскада
      await this._runAutopilot();

      summary = this._writeJournal(entry, order, reportsTouched, effectsRun, data);
      if (data.mode !== 'force') {
        showToast('⚙ Авто-пересчёт 24/7: ' + summary.eventLabel + ' → ' + order.length + ' контур(ов)');
      }
    } catch (e) {
      console.error('[bi_engine] cascade failed', e);
    } finally {
      // ── снятие флага + запуск ОДНОГО отложенного прогона (без рекурсии)
      this._running = false;
      if (this._queued) {
        const q = this._queued;
        this._queued = null;
        setTimeout(() => this.executeDeepBusinessIntelligence(q.event, q.data), 0);
      }
    }
    return summary;
  }

  /** Топологический порядок слоёв от входного узла (BFS по next[]). */
  _topoOrder(entry) {
    const order = [], seen = {}, queue = [entry];
    while (queue.length) {
      const n = queue.shift();
      if (!n || seen[n] || !RECALC_GRAPH[n]) continue;
      seen[n] = true;
      order.push(n);
      for (const nx of (RECALC_GRAPH[n].next || [])) if (!seen[nx]) queue.push(nx);
    }
    return order;
  }

  /**
   * Пересчёт одного слоя каскада. Каждый слой — отдельная асинхронная операция;
   * результат пишется в store, следующий слой читает уже обновлённые данные.
   */
  async _runLayer(node, ctx) {
    const store = this.store;
    switch (node) {
      case 'rates':
        // [1] Кросс-курсы ЦБ/биржа на даты операций + контур НДС
        await recomputeCrossRates(store);
        ctx.reportsTouched.push('Кросс-курсы', 'Контур НДС');
        break;

      case 'purchases':
        // [2] Landed Cost = инвойс·курс + логистика + таможня + брокер
        await recomputeLandedCost(store);
        ctx.reportsTouched.push('Landed Cost / ВЭД');
        break;

      case 'production':
        // [3] Себестоимость 1 кг ГП по дням Недельного плана.
        //     Метод определяется флагом company.costMethod ('batch' | 'fifo').
        await recomputeCostPerKg(store);
        ctx.reportsTouched.push('Себестоимость 1 кг', 'План производства');
        break;

      case 'delivery':
        // [5] Сквозной баланс снабжения + авто-задача логисту при дефиците
        const def = await recomputeDeliveryBalance(store);
        if (def) ctx.effectsRun.push(def);
        ctx.reportsTouched.push('Доставка · баланс по дням');
        break;

      case 'sales':
        // [4-вход] Реестр продаж (выручка по курсу отгрузки)
        ctx.reportsTouched.push('Реестр продаж');
        break;

      case 'finance':
        // [4] Маржа GM1/GM2 (НДС + удельный вес ₽/кг и €/кг), P&L, курсовые разницы
        await recomputeMargin(store);
        ctx.reportsTouched.push('Маржинальный анализ 360°', 'P&L · курсовые разницы', 'GM1/GM2 на 1 кг');
        break;

      case 'kpi':
        // [6] KPI/рейтинг сотрудников, звёзды у аватарок
        await recomputeKpiRatings(store);
        ctx.reportsTouched.push('Рейтинг KPI', '★ звёзды у аватарок');
        break;
    }
  }

  /** Оркестратор ИИ-автопилота (idempotent, с собственным guard). */
  async _runAutopilot() {
    if (this._autoBusy) return;
    this._autoBusy = true;
    try { await runAutopilotContours(this.store); }
    catch (e) { console.error('[bi_engine] autopilot', e); }
    this._autoBusy = false;
  }

  /** Запись прогона в журнал пересчётов (для UI и аудита). */
  _writeJournal(entry, order, reports, effects, data) {
    const ev = (data.events && data.events[0]) || 'FULL_RECALC';
    const summary = {
      at: Date.now(),
      event: ev,
      eventLabel: data.mode === 'force' ? 'Принудительный полный пересчёт' : eventLabel(ev),
      entry,
      chain: order.map((n) => RECALC_GRAPH[n].label),
      reports: [...new Set(reports)],
      effects,
      nodes: order.length,
      mode: data.mode || 'auto',
    };
    const log = [summary, ...(this.store.get('recalcLog') || [])].slice(0, 40);
    this.store.set('recalcLog', log);
    return summary;
  }

  // ───────────────────────────────────────────────────────────────────────
  // КОНТУР Б — РУЧНОЙ ПРИНУДИТЕЛЬНЫЙ ЗАПУСК + ПОШАГОВЫЙ ЛОАДЕР
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Кнопка «🚀 Запустить сквозной пересчёт и ИИ-анализ» (Reset & Full Audit).
   * Полный тяжёлый прогон всего графа с пошаговым визуальным лоадером,
   * блокировкой кнопки и Toast-уведомлением по завершении.
   */
  async forceGlobalRecalc() {
    if (this.store.get('recalcRunning')) return; // кнопка временно заблокирована
    this.store.set('recalcRunning', true);

    // Переключатель этапов прогресс-бара (Progress Controller)
    const steps = [
      ['Шаг 1: Кросс-курсы ЦБ/биржи и контур НДС…', () => recomputeCrossRates(this.store)],
      ['Шаг 2: Landed Cost закупок (факторный анализ)…', () => recomputeLandedCost(this.store)],
      ['Шаг 3: Дефициты и Недельный план (FIFO/партии)…', async () => {
        await recomputeCostPerKg(this.store);
        await recomputeDeliveryBalance(this.store);
      }],
      ['Шаг 4: Генерация ИИ-инсайтов · Точки роста…', () => {
        recomputeMargin(this.store);
        recomputeKpiRatings(this.store);
      }],
    ];

    for (const [label, fn] of steps) {
      setLoaderStep(label);     // обновляем текст лоадера на экране
      await this.delay(440);    // даём пользователю увидеть этап
      try { await fn(); } catch (e) { console.error('[bi_engine] force step', label, e); }
    }

    // финальный полный каскад (на случай зависимостей между этапами)
    await this.executeDeepBusinessIntelligence('rates', { mode: 'force', events: ['FULL_RECALC'] });

    this.store.set('recalcRunning', false);
    clearLoader();
    showToast('🚀 Полный сквозной пересчёт и ИИ-аудит завершены ✓');
  }

  /** Очистка таймеров при размонтировании (защита от утечек памяти). */
  dispose() {
    for (const k in this._debounceTimers) clearTimeout(this._debounceTimers[k]);
    this._debounceTimers = {};
    this._pendingEvents.clear();
    this._queued = null;
  }
}
