/**
 * js/core/recalc_graph.js
 * ============================================================================
 * ГРАФ ЗАВИСИМОСТЕЙ КОНТУРОВ ПЕРЕСЧЁТА
 * ============================================================================
 * Декларативное описание каскада: какой слой какие отчёты пересчитывает и куда
 * передаёт поток дальше. bi_engine.js обходит этот граф в топологическом порядке.
 * @module core/recalc_graph
 */

/** Узлы каскада (по порядку движения финансового потока). */
export const RECALC_GRAPH = {
  rates: {
    label: 'Курсы ЦБ / контур НДС',
    reports: ['Кросс-курсы RUB/EUR/CNY', 'Контур НДС'],
    next: ['purchases'],
  },
  purchases: {
    label: 'Закупки → Landed Cost',
    reports: ['Landed Cost / ВЭД', 'Анализ себестоимости (план)'],
    next: ['production'],
  },
  production: {
    label: 'Производство (СС 1 кг, план по дням)',
    reports: ['Себестоимость 1 кг', 'План производства', 'Плановая СС'],
    next: ['delivery', 'sales'],
  },
  delivery: {
    label: 'Доставка (баланс снабжения)',
    reports: ['Доставка · проекция остатков по дням'],
    effects: ['deficitTasks'],
    next: [],
  },
  sales: {
    label: 'Продажи (выручка)',
    reports: ['Реестр продаж'],
    next: ['finance'],
  },
  finance: {
    label: 'Финансы (маржа GM1/GM2, P&L)',
    reports: ['Маржинальный анализ 360°', 'P&L · курсовые разницы', 'GM1/GM2 на 1 кг'],
    next: ['kpi'],
  },
  kpi: {
    label: 'Рейтинг и KPI',
    reports: ['Рейтинг KPI', '★ звёзды у аватарок'],
    effects: ['kpiStars'],
    next: [],
  },
};

/** Событие контура → входной узел графа. */
export const EVENT_ENTRY_MAP = {
  RATES_OR_VAT_CHANGE: 'rates',
  NEW_PURCHASE: 'purchases',
  NEW_LANDED_COST: 'purchases',
  NEW_RECEIPT: 'purchases',
  STOCK_CHANGE: 'purchases',
  NEW_PRODUCTION_PLAN: 'production',
  NEW_SALES: 'sales',
  NEW_FACT_DOCS: 'kpi',
  TASK_FACT: 'kpi',
  FULL_RECALC: 'rates',
};

const EVENT_LABELS = {
  RATES_OR_VAT_CHANGE: 'Смена курса / контура НДС',
  NEW_PURCHASE: 'Новая закупка / партия',
  NEW_LANDED_COST: 'Загрузка Landed Cost',
  NEW_RECEIPT: 'Поступление на склад',
  STOCK_CHANGE: 'Изменение остатков',
  NEW_PRODUCTION_PLAN: 'Изменение плана выпуска',
  NEW_SALES: 'Новые продажи',
  NEW_FACT_DOCS: 'Факт. документы 1С:КА',
  TASK_FACT: 'Факт по задачам',
  FULL_RECALC: 'Полный сквозной пересчёт',
};

export function eventLabel(ev) { return EVENT_LABELS[ev] || ev; }
