/**
 * js/core/analytics_engine.js
 * ============================================================================
 * АНАЛИТИЧЕСКИЙ ДВИЖОК — СЕБЕСТОИМОСТЬ, МАРЖА, LANDED COST
 * ============================================================================
 * Гибридный учёт себестоимости в разрезе компаний:
 *   • Компания №1 — ПАРТИОННЫЙ учёт (списание по фактической Landed Cost партии).
 *   • Компания №2 — FIFO по хронологии выпусков (партий нет): сырьё списывается
 *     из самых ранних по дате приходов 1С:КА, формируя средневзвешенную СС 1 кг
 *     ГП на дату выпуска.
 *
 * Метод выбирается флагом company.costMethod === 'fifo' | 'batch'.
 * @module core/analytics_engine
 */

import { getCompany } from '../data/company_config.js';

// ────────────────────────────────────────────────────────────────────────────
// ДИСПЕТЧЕР: выбор контура учёта по company_id
// ────────────────────────────────────────────────────────────────────────────

/**
 * Себестоимость 1 кг готового продукта на дату выпуска.
 * @param {object} store
 * @param {string} product       — наименование ГП
 * @param {number} qtyKg         — выпускаемый объём, кг
 * @param {string} releaseDate   — дата выпуска (ISO 'YYYY-MM-DD')
 * @returns {{ method:'batch'|'fifo', costPerKg:number, costTotal:number,
 *            consumption:Array, marker:string }}
 */
export function computeFinishedCost(store, product, qtyKg, releaseDate) {
  const company = getCompany(store.get('activeCompanyId'));
  if (company.costMethod === 'fifo') {
    return fifoFinishedCost(store, product, qtyKg, releaseDate);
  }
  return batchFinishedCost(store, product, qtyKg, releaseDate);
}

// ────────────────────────────────────────────────────────────────────────────
// КОНТУР КОМПАНИИ №1 — ПАРТИОННЫЙ УЧЁТ
// ────────────────────────────────────────────────────────────────────────────

/**
 * Списание по конкретным партиям закупки: берём Landed Cost именно той партии
 * сырья, что ушла в производство (приоритет — отчёт «Анализ себестоимости»).
 */
function batchFinishedCost(store, product, qtyKg, releaseDate) {
  const recipe = store.getRecipe(product);              // [{ material, share }]
  const batchCost = store.getBatchLandedCostMap();      // { materialKey: ₽/кг по партии }
  let costPerKg = 0;
  const consumption = [];
  for (const line of recipe) {
    const unit = batchCost[store.norm(line.material)] || 0;
    costPerKg += line.share * unit;
    consumption.push({
      material: line.material,
      qtyKg: qtyKg * line.share,
      unitCost: unit,
      sourceBatch: store.getBatchNo(line.material) || '—',
    });
  }
  return {
    method: 'batch',
    costPerKg,
    costTotal: costPerKg * qtyKg,
    consumption,
    marker: 'Партия ' + (consumption[0] ? consumption[0].sourceBatch : '—'),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// КОНТУР КОМПАНИИ №2 — FIFO ПО ХРОНОЛОГИИ ВЫПУСКОВ
// ────────────────────────────────────────────────────────────────────────────

/**
 * FIFO-СПИСАНИЕ МАТЕРИАЛЬНЫХ ПОТОКОВ.
 *
 * Для каждого сырья из рецептуры ГП:
 *   1. Берём все приходы сырья из 1С:КА, СОРТИРУЕМ по upload_timestamp ASC
 *      (первый пришёл — первый ушёл).
 *   2. Последовательно «вычитаем» требуемый под производство вес из самой
 *      старой временной группы; когда она исчерпана — переходим к следующей.
 *   3. Накапливаем стоимость списания → средневзвешенная цена ₽/кг сырья.
 *   4. Сумма по всем строкам рецептуры × доля = себестоимость 1 кг ГП.
 *
 * Возвращает удельную СС, детализацию потребления и текстовый FIFO-маркер
 * для 5-го уровня drill-down («[FIFO] Списание по приходу от ДД.ММ.ГГГГ»).
 *
 * ВАЖНО (консистентность): исторические закрытые периоды не пересчитываются;
 * FIFO стартует от остатков на начало текущего открытого периода.
 */
function fifoFinishedCost(store, product, qtyKg, releaseDate) {
  const recipe = store.getRecipe(product);
  let costPerKg = 0;
  const consumption = [];
  let earliestUsedDate = null;

  for (const line of recipe) {
    const needKg = qtyKg * line.share;       // сколько сырья нужно под выпуск
    if (needKg <= 0) continue;

    // (1) приходы этого сырья, отсортированные по дате загрузки (ASC)
    const lots = store
      .getIncomingLots(line.material)         // [{ qtyKg, unitCostRub, uploadTimestamp, docDate }]
      .filter((l) => l.uploadTimestamp <= toTs(releaseDate)) // только приходы до даты выпуска
      .slice()
      .sort((a, b) => a.uploadTimestamp - b.uploadTimestamp);

    // (2)+(3) последовательное FIFO-вычитание
    let remaining = needKg;
    let spentRub = 0;
    const usedLots = [];
    for (const lot of lots) {
      if (remaining <= 1e-9) break;
      const take = Math.min(lot.qtyKg, remaining);   // берём из этой партии
      spentRub += take * lot.unitCostRub;
      remaining -= take;
      usedLots.push({ date: lot.docDate, qtyKg: take, unitCostRub: lot.unitCostRub });
      if (!earliestUsedDate || lot.docDate < earliestUsedDate) earliestUsedDate = lot.docDate;
    }

    // если приходов не хватило — добиваем последней известной ценой (или 0)
    if (remaining > 1e-9) {
      const lastPrice = lots.length ? lots[lots.length - 1].unitCostRub : 0;
      spentRub += remaining * lastPrice;
      usedLots.push({ date: '—', qtyKg: remaining, unitCostRub: lastPrice, shortfall: true });
    }

    // (4) средневзвешенная цена сырья по FIFO и вклад в СС готового продукта
    const wavgUnit = needKg > 0 ? spentRub / needKg : 0;
    costPerKg += line.share * wavgUnit;
    consumption.push({ material: line.material, qtyKg: needKg, unitCost: wavgUnit, usedLots });
  }

  const marker = earliestUsedDate
    ? '[FIFO] Списание по приходу от ' + fmtRu(earliestUsedDate)
    : '[FIFO] нет приходов в периоде';

  return { method: 'fifo', costPerKg, costTotal: costPerKg * qtyKg, consumption, marker };
}

// ────────────────────────────────────────────────────────────────────────────
// МАРЖА GM1/GM2 — кросс-курс на дату отгрузки, СС на дату выпуска, контур НДС
// ────────────────────────────────────────────────────────────────────────────

/**
 * Маржинальность сделки с учётом мультивалюты и удельного веса.
 * GM1_EUR = Цена_EUR − (Себестоимость_RUB / Курс_EUR_на_дату_отгрузки)
 * GM2 = GM1 − удельная логистика − КВ. Процент маржи инвариантен к валюте.
 */
export function computeMargin(store, deal) {
  const rateShip = store.getCbrRate(deal.shipDate);          // курс на дату отгрузки
  const cost = computeFinishedCost(store, deal.product, deal.qtyKg, deal.releaseDate);
  const vat = store.get('vatMode') === 'WITHOUT' ? store.vatRateFor(deal) : 0;
  const priceRub = deal.priceRub / (1 + vat);                // очистка от НДС при необходимости

  const revenueRub = priceRub * deal.qtyKg;
  const cogsRub = cost.costTotal;
  const gm1Rub = revenueRub - cogsRub;
  const gm2Rub = gm1Rub - (deal.logisticsRub || 0) - (deal.commissionRub || 0);

  return {
    method: cost.method,
    marker: cost.marker,                 // партия или [FIFO]-маркер для drill-down
    revenueRub, cogsRub, gm1Rub, gm2Rub,
    gm1Eur: gm1Rub / rateShip,
    gm2Eur: gm2Rub / rateShip,
    gm1Pct: revenueRub ? (gm1Rub / revenueRub) * 100 : 0,
    gm2Pct: revenueRub ? (gm2Rub / revenueRub) * 100 : 0,
    gm2PerKg: deal.qtyKg ? gm2Rub / deal.qtyKg : 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// ИИ-ИНТЕРПРЕТАТОР АНОМАЛИЙ СЕБЕСТОИМОСТИ (с учётом метода учёта)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Объясняет скачок себестоимости 1 кг. Для FIFO-компании распознаёт переход
 * со старых дешёвых запасов на более дорогую свежую выгрузку 1С.
 */
export function interpretCostJump(store, product, prevCost, newCost) {
  if (!(prevCost > 0) || !(newCost > prevCost)) return null;
  const jumpPct = ((newCost - prevCost) / prevCost) * 100;
  if (jumpPct < 5) return null;

  const company = getCompany(store.get('activeCompanyId'));
  if (company.costMethod === 'fifo') {
    const cost = fifoFinishedCost(store, product, 1, store.todayIso());
    const lot = cost.consumption[0] && cost.consumption[0].usedLots.slice(-1)[0];
    const when = lot ? fmtRu(lot.date) : 'свежей выгрузки';
    return (
      'Внимание: Себестоимость 1 кг продукции выросла на ' + jumpPct.toFixed(0) + '%, ' +
      'так как система полностью списала старые дешёвые запасы сырья и перешла на ' +
      'расчёт по FIFO из более дорогой выгрузки 1С от ' + when + '.'
    );
  }
  return (
    'Себестоимость 1 кг выросла на ' + jumpPct.toFixed(0) + '% — проверьте Landed Cost ' +
    'списанной партии (курс, логистика, цена поставщика).'
  );
}

// ────────────────────────────────────────────────────────────────────────────
// ХУКИ КАСКАДА (вызываются bi_engine.js послойно)
// ────────────────────────────────────────────────────────────────────────────

export async function recomputeLandedCost(store) { store.recomputeLandedCost(); }
export async function recomputeCostPerKg(store) { store.recomputeCostPerKg(computeFinishedCost); }
export async function recomputeMargin(store) { store.recomputeMargin(computeMargin); }
export async function recomputeDeliveryBalance(store) { return store.recomputeDeliveryBalance(); }
export async function recomputeKpiRatings(store) { store.recomputeKpiRatings(); }

// ────────────────────────────────────────────────────────────────────────────
// Метка метода учёта для Excel (ячейка A3) и шапок drill-down
// ────────────────────────────────────────────────────────────────────────────

export function inventoryMethodLabel(store) {
  const company = getCompany(store.get('activeCompanyId'));
  return company.costMethod === 'fifo'
    ? 'Метод оценки стоимости запасов: FIFO по хронологии выпусков'
    : 'Метод оценки стоимости запасов: Партионный учёт (Landed Cost)';
}

export function drilldownColumnLabel(store) {
  const company = getCompany(store.get('activeCompanyId'));
  return company.costMethod === 'fifo'
    ? 'Временной блок списания (FIFO)'
    : 'Номер партии закупки (Landed Cost)';
}

// ── утилиты ──
function toTs(iso) { const d = new Date(iso); return isNaN(d) ? Date.now() : d.getTime(); }
function fmtRu(iso) { if (!iso || iso === '—') return iso; const p = String(iso).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso; }
