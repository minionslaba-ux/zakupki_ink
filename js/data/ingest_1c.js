/**
 * js/data/ingest_1c.js
 * ============================================================================
 * СЕМАНТИЧЕСКИЙ ИИ-МАППИНГ И КЛИНИНГ ВЫГРУЗОК 1С:КА
 * ============================================================================
 * Распознаёт колонки по смыслу слов (рус/англ синонимы) и по ТИПУ данных,
 * фильтрует шум (пустые строки, подвалы, разделители), детектирует инвойсы.
 * Используется и фронтендом (data_uploader.js), и почтовым воркером (mail_parser.js).
 * @module data/ingest_1c
 */

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Синонимы колонок по смыслу (рус + англ). */
const RULES = {
  nomen:     ['номенклат', 'товар', 'материал', 'сырь', 'продукт', 'наименован', 'издели', 'позиц', 'марка', 'item', 'product', 'material', 'name', 'goods', 'sku'],
  qty:       ['кол-во', 'количеств', 'объ[её]м', 'остаток', 'вес', 'масса', 'qty', 'quantity', 'amount', 'volume', 'weight'],
  price:     ['цена', 'тариф', 'ставка', 'прайс', 'price', 'rate', 'unit price'],
  sum:       ['сумма', 'стоимост', 'итого', 'sum', 'total', 'cost', 'value'],
  date:      ['дата', 'период', 'date', 'period'],
  supplier:  ['поставщик', 'продавец', 'фабрик', 'vendor', 'supplier', 'seller'],
  client:    ['клиент', 'контрагент', 'покупател', 'заказчик', 'client', 'customer', 'buyer'],
  warehouse: ['склад', 'warehouse', 'store'],
  unit:      ['ед.', 'ед ', 'единиц', 'unit', 'uom'],
};

/**
 * Профиль колонки: доли типов и масштаб значений (для добора по типу данных).
 */
export function columnStats(rows, idx) {
  let tot = 0, num = 0, dateN = 0, txt = 0, sumAbs = 0, intN = 0, lenSum = 0;
  for (const r of (rows || []).slice(0, 50)) {
    const v = r ? r[idx] : null;
    if (v == null || String(v).trim() === '') continue;
    tot++;
    const s = String(v).trim();
    const cleaned = s.replace(/[\s₽€%]/g, '').replace(',', '.');
    const n = parseFloat(cleaned);
    const isNum = /^-?[\d.]+$/.test(cleaned) && isFinite(n);
    if (isNum) { num++; sumAbs += Math.abs(n); if (Math.abs(n - Math.round(n)) < 1e-9) intN++; }
    else if (/^\d{1,4}[.\-/]\d{1,2}[.\-/]\d{1,4}/.test(s) || (/^\d{5}$/.test(s) && +s > 30000 && +s < 90000)) dateN++;
    else { txt++; lenSum += s.length; }
  }
  return {
    tot, numShare: tot ? num / tot : 0, dateShare: tot ? dateN / tot : 0,
    txtShare: tot ? txt / tot : 0, avgAbs: num ? sumAbs / num : 0,
    intShare: num ? intN / num : 0, avgLen: txt ? lenSum / txt : 0,
  };
}

/**
 * Семантический маппинг шапки: сперва по названию (синонимы), затем добор по
 * типу данных колонки. Возвращает { поле: индексКолонки }.
 */
export function semanticHeaderMap(headers, rows) {
  const map = {};
  const H = headers.map(norm);
  for (const field of Object.keys(RULES)) {
    const idx = H.findIndex((h) => RULES[field].some((syn) => new RegExp(syn).test(h)));
    if (idx >= 0 && !Object.values(map).includes(idx)) map[field] = idx;
  }
  if (rows && rows.length) {
    const stats = headers.map((_, i) => columnStats(rows, i));
    const used = () => new Set(Object.values(map));
    const free = (i) => !used().has(i);
    if (map.nomen == null) { let b = -1, bl = 0; stats.forEach((s, i) => { if (free(i) && s.txtShare > 0.6 && s.avgLen > bl) { bl = s.avgLen; b = i; } }); if (b >= 0) map.nomen = b; }
    if (map.date == null) { const i = stats.findIndex((s, i) => free(i) && s.dateShare > 0.5); if (i >= 0) map.date = i; }
    if (map.sum == null) { let b = -1, ba = 0; stats.forEach((s, i) => { if (free(i) && s.numShare > 0.7 && s.avgAbs > ba) { ba = s.avgAbs; b = i; } }); if (b >= 0) map.sum = b; }
    if (map.qty == null) { let b = -1, bs = 0; stats.forEach((s, i) => { if (free(i) && s.numShare > 0.7) { const sc = s.intShare / (1 + Math.log10(1 + s.avgAbs)); if (sc > bs) { bs = sc; b = i; } } }); if (b >= 0) map.qty = b; }
    if (map.price == null) { const i = stats.findIndex((s, i) => free(i) && s.numShare > 0.7); if (i >= 0) map.price = i; }
  }
  return map;
}

/** Фильтрация шума: пустые строки, итоговые подвалы, бухгалтерские разделители. */
export function cleanNoiseRows(rows) {
  return (rows || []).filter((row) => {
    if (!row) return false;
    const nonEmpty = row.map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
    if (!nonEmpty.length) return false;
    const joined = norm(nonEmpty.join(' '));
    if (/^(итого|всего|итог|подытог|баланс|оборот|сальдо|в том числе|примечани|подпис|исполнител|ответствен|главный бухгалтер|руководител|м\.п\.|страница|стр\.)/.test(joined)) {
      if (nonEmpty.length <= 3 || /^(итого|всего|итог|подытог)/.test(joined)) return false;
    }
    if (nonEmpty.every((c) => /^[-=_.*]+$/.test(c))) return false;
    return true;
  });
}

/** Детектор инвойса поставщика: номенклатура + кол-во/сумма + признак поставщика. */
export function detectInvoice(headers, rows) {
  const map = semanticHeaderMap(headers, rows);
  const H = headers.map(norm);
  const hasSupplier = map.supplier != null || H.some((h) => /поставщик|продавец|seller|vendor|инвойс|invoice|счёт|счет/.test(h));
  const hasItems = map.nomen != null && (map.qty != null || map.price != null || map.sum != null);
  if (!hasItems) return null;
  let supplier = '';
  if (map.supplier != null) for (const r of rows) { const v = r[map.supplier]; if (v && String(v).trim()) { supplier = String(v).trim(); break; } }
  const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
  const items = rows.map((r) => ({
    nomenclature: map.nomen != null ? String(r[map.nomen] == null ? '' : r[map.nomen]).trim() : '',
    qty: map.qty != null ? num(r[map.qty]) : 0,
    price_per_unit: map.price != null ? num(r[map.price]) : 0,
    total: map.sum != null ? num(r[map.sum]) : 0,
  })).filter((it) => it.nomenclature && (it.qty || it.total));
  if (!items.length) return null;
  return {
    confident: hasSupplier && items.length >= 1,
    supplier: supplier || '—',
    items, map,
    itemsAsRows: items.map((it) => [it.nomenclature, it.qty, it.price_per_unit, it.total]),
    total: items.reduce((s, it) => s + (it.total || it.qty * it.price_per_unit), 0),
  };
}
