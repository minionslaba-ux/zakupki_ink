/**
 * js/modules/delivery_report.js
 * ============================================================================
 * MRP-ОТЧЁТ «ДОСТАВКА» — сквозной баланс снабжения (45 дней вперёд)
 * ============================================================================
 * Строчный горизонтальный UI на CSS Grid: календарная сетка по дням.
 * 5-уровневый drill-down: Группа → SKU → Даты прихода → Первичный документ →
 * Партия Landed Cost (Компания №1) / Временной блок FIFO (Компания №2).
 * 4-уровневая тепловая карта; клик по красному → ИИ-вердикт упущенной выгоды.
 * Ховер-левитация строк; @media print для чистой распечатки.
 *
 * Формула остатка по дням:  Остаток(T) = Остаток(T−1) + Приход(T) − Потребность(T)
 *
 * @module modules/delivery_report
 */

const HORIZON_DAYS = 45;

export class DeliveryReport {
  /** @param {HTMLElement} mount @param {object} ctx — { store } */
  constructor(mount, ctx) {
    this.mount = mount;
    this.store = ctx.store;
    this.expanded = {};   // раскрытые узлы drill-down
  }

  // ── ДАННЫЕ: проекция остатков по дням ───────────────────────────────────
  /**
   * Считает по каждому сырью серию остатков на HORIZON_DAYS вперёд и уровень
   * тепловой карты. Возвращает структуру для рендера + дерево drill-down.
   */
  compute() {
    const today = this._midnight(new Date());
    const days = [];
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      days.push({ iso: this._iso(d), label: d.getDate() + '.' + (d.getMonth() + 1) });
    }
    const materials = this.store.getDeliveryMaterials(); // [{ key,name,group,unit,stock,dailyNeed,safety,leadDays, arrivals:[{date,qty,doc,batch,fifoBlock}] }]
    const rows = materials.map((m) => {
      const arrByDay = {};
      for (const a of m.arrivals) if (arrByDay[a.date] == null) arrByDay[a.date] = 0, arrByDay[a.date] += a.qty;
      let bal = m.stock, minBal = bal, deficitIso = '';
      const cells = days.map((day) => {
        const inc = arrByDay[day.iso] || 0;
        bal = bal + inc - m.dailyNeed;
        if (bal < minBal) minBal = bal;
        if (!deficitIso && bal < 0) deficitIso = day.iso;
        return { iso: day.iso, bal, inc, level: this._heatLevel(bal, m) };
      });
      const level = deficitIso ? 'red' : (minBal < m.safety ? (minBal < m.safety * 0.5 ? 'orange' : 'yellow') : 'green');
      return { ...m, cells, minBal, deficitIso, level };
    });
    // сортировка по тяжести
    const order = { red: 0, orange: 1, yellow: 2, green: 3 };
    rows.sort((a, b) => order[a.level] - order[b.level] || a.minBal - b.minBal);
    return { days, rows };
  }

  /** 4-уровневая тепловая карта по остатку дня. */
  _heatLevel(bal, m) {
    if (bal < 0) return 'red';                       // 🔴 дефицит / сырьевой провал
    if (bal < m.safety) return 'orange';             // 🟠 риск задержки 1–2 дня
    if (m.dailyNeed > 0 && bal / m.dailyNeed > 45) return 'yellow'; // 🟡 избыток / заморозка
    return 'green';                                  // 🟢 норма
  }

  // ── РЕНДЕР ──────────────────────────────────────────────────────────────
  render() {
    const { days, rows } = this.compute();
    const headCells = days.map((d) => `<span class="dlv-daycol">${d.label}</span>`).join('');
    const body = rows.map((r) => this._rowHtml(r, days)).join('');
    this.mount.innerHTML = `
      <div class="dlv-report">
        <div class="dlv-legend">
          <span class="dlv-leg"><i class="dlv-dot green"></i>Норма</span>
          <span class="dlv-leg"><i class="dlv-dot yellow"></i>Избыток / заморозка</span>
          <span class="dlv-leg"><i class="dlv-dot orange"></i>Риск задержки</span>
          <span class="dlv-leg"><i class="dlv-dot red"></i>Дефицит</span>
        </div>
        <div class="dlv-grid" style="--days:${days.length}">
          <div class="dlv-hd"><span class="dlv-name">Сырьё / SKU</span>${headCells}</div>
          ${body}
        </div>
      </div>`;
    this._bind();
  }

  _rowHtml(r, days) {
    const cells = r.cells.map((c) =>
      `<span class="dlv-cell heat-${c.level}" data-iso="${c.iso}" data-mat="${r.key}" title="${Math.round(c.bal)} ${r.unit}"></span>`
    ).join('');
    return `
      <div class="dlv-row level-${r.level}" data-mat="${r.key}">
        <span class="dlv-name" data-toggle="${r.key}">
          <span class="dlv-chev">▸</span>${r.name}
          <small class="dlv-grp">${r.group}</small>
        </span>${cells}
      </div>
      <div class="dlv-drill" data-drill="${r.key}" hidden></div>`;
  }

  _bind() {
    // раскрытие drill-down (Accordion)
    this.mount.querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => this._toggleDrill(el.dataset.toggle));
    });
    // клик по красной ячейке → ИИ-вердикт упущенной выгоды
    this.mount.querySelectorAll('.dlv-cell.heat-red').forEach((cell) => {
      cell.addEventListener('click', () => this._showMissedProfit(cell.dataset.mat, cell.dataset.iso));
    });
  }

  /** 5-уровневый drill-down: Группа → SKU → Даты → Первичный документ → Партия/FIFO. */
  _toggleDrill(matKey) {
    const box = this.mount.querySelector(`[data-drill="${matKey}"]`);
    const row = this.mount.querySelector(`.dlv-row[data-mat="${matKey}"] .dlv-chev`);
    if (!box) return;
    this.expanded[matKey] = !this.expanded[matKey];
    box.hidden = !this.expanded[matKey];
    if (row) row.textContent = this.expanded[matKey] ? '▾' : '▸';
    if (!this.expanded[matKey]) return;
    const m = this.store.getDeliveryMaterials().find((x) => x.key === matKey);
    const isFifo = this.store.activeCompanyCostMethod() === 'fifo';
    const lotCol = isFifo ? 'Временной блок (FIFO)' : 'Партия (Landed Cost)';
    const lots = (m ? m.arrivals : []).map((a) => `
      <div class="dlv-drill-row">
        <span>${this._fmtRu(a.date)}</span>
        <span>${a.qty.toLocaleString('ru-RU')} ${m.unit}</span>
        <span>${a.doc || '—'}</span>
        <span>${isFifo ? ('[FIFO] от ' + this._fmtRu(a.date)) : ('Партия ' + (a.batch || '—'))}</span>
      </div>`).join('');
    box.innerHTML = `
      <div class="dlv-drill-hd"><span>Дата прихода</span><span>Объём</span><span>Первичный документ</span><span>${lotCol}</span></div>
      ${lots || '<div class="dlv-drill-empty">Приходов в горизонте нет.</div>'}`;
  }

  /** ИИ-вердикт упущенной выгоды при дефиците. */
  _showMissedProfit(matKey, iso) {
    const verdict = this.store.computeMissedProfit(matKey, iso); // { material, shortKg, lostMarginEur, date }
    const html = `
      <div class="dlv-mp">
        <div class="dlv-mp-ttl">🔴 ИИ-анализ упущенной выгоды</div>
        <div class="dlv-mp-txt">
          Дефицит «${verdict.material}» на ${this._fmtRu(iso)}: нехватка ≈ ${Math.round(verdict.shortKg).toLocaleString('ru-RU')} кг.
          Под угрозой срыв плана выпуска — упущенная чистая маржа ≈ <b>${Math.round(verdict.lostMarginEur).toLocaleString('ru-RU')} €</b>.
          Рекомендация: запустить авто-выкуп (ИИ-Автопилот) у поставщика с лучшим OTIF.
        </div>
      </div>`;
    const box = this.mount.querySelector(`[data-drill="${matKey}"]`);
    if (box) { box.hidden = false; box.innerHTML = html; this.expanded[matKey] = true; }
  }

  // ── утилиты ──
  _midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  _iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  _fmtRu(iso) { const p = String(iso).split('-'); return p.length === 3 ? p[2] + '.' + p[1] + '.' + p[0] : iso; }
}

/** CSS модуля (CSS Grid + тепловая карта + левитация + печать). */
export const DELIVERY_CSS = `
.dlv-legend{display:flex;gap:16px;margin-bottom:10px;font-size:12px;color:#56534f}
.dlv-leg{display:flex;align-items:center;gap:6px}
.dlv-dot{width:11px;height:11px;border-radius:3px;display:inline-block}
.dlv-dot.green{background:#bfe3c6}.dlv-dot.yellow{background:#f3e3a8}
.dlv-dot.orange{background:#f5cfa0}.dlv-dot.red{background:#f3b4ad}
.dlv-grid{border:1px solid #e7e4e0;border-radius:11px;overflow:auto}
.dlv-hd,.dlv-row{display:grid;grid-template-columns:220px repeat(var(--days),18px);gap:2px;align-items:center;padding:6px 12px}
.dlv-hd{background:#f6f3ef;position:sticky;top:0;font-size:9px;font-weight:700;color:#8a8782}
.dlv-daycol{writing-mode:vertical-rl;transform:rotate(180deg);text-align:right;height:34px}
.dlv-row{border-top:1px solid #f0ece6;transition:transform .14s ease,box-shadow .14s ease;background:#fff}
.dlv-row:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.08);position:relative;z-index:2}
.dlv-name{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:#2b2926;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dlv-grp{color:#9a9793;font-weight:500}
.dlv-chev{color:#b3aea7;font-size:10px;width:11px}
.dlv-cell{height:18px;border-radius:3px;cursor:default}
.dlv-cell.heat-green{background:#e3f3e6}.dlv-cell.heat-yellow{background:#fbf4d6}
.dlv-cell.heat-orange{background:#fce6cf}.dlv-cell.heat-red{background:#f8d3cd;cursor:pointer}
.dlv-cell.heat-red:hover{outline:2px solid #c0322b}
.dlv-drill{padding:8px 16px;background:#fbfaf8;border-top:1px solid #f0ece6}
.dlv-drill-hd,.dlv-drill-row{display:grid;grid-template-columns:1fr 1fr 1.6fr 1.6fr;gap:10px;font-size:12px;padding:5px 0}
.dlv-drill-hd{font-weight:700;color:#8a8782;text-transform:uppercase;font-size:10px}
.dlv-drill-row{border-top:1px dashed #ece8e2}
.dlv-mp{background:#fdf6f5;border:1px solid #f2d8d5;border-radius:9px;padding:11px 14px}
.dlv-mp-ttl{font-size:12.5px;font-weight:800;color:#c0322b;margin-bottom:5px}
.dlv-mp-txt{font-size:12.5px;line-height:1.55;color:#7a3b34}
@media print{
  body > *:not(.dlv-report){display:none !important}
  .dlv-report{margin:0}
  .dlv-row:hover{transform:none;box-shadow:none}
}
`;
