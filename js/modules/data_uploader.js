/**
 * js/modules/data_uploader.js
 * ============================================================================
 * ЗАЩИЩЁННОЕ ОКНО РУЧНОЙ ЗАГРУЗКИ ДАННЫХ 1С:КА
 * ============================================================================
 * Четыре системных столпа Манифеста встроены по умолчанию:
 *   • RBAC-маскировка под 404 для пользователей без права загрузки;
 *   • семантический ИИ-маппинг шапок (рус/англ синонимы + тип данных);
 *   • PDF (текстовый слой PDF.js + OCR Tesseract.js) и Excel/CSV/TXT;
 *   • финальный клик → асинхронный движок executeDeepBusinessIntelligence().
 *
 * Зависит от: core/bi_engine.js, data/ingest_1c.js, ui/toast.js
 * Внешние библиотеки (CDN, ext-resource): SheetJS (XLSX), PDF.js, Tesseract.js
 * @module modules/data_uploader
 */

import { BiEngine } from '../core/bi_engine.js';
import { semanticHeaderMap, cleanNoiseRows, columnStats } from '../data/ingest_1c.js';
import { showToast } from '../ui/toast.js';
import { render404 } from './security_log.js';

/** Пять базовых отчётов 1С:КА + правила распознавания обязательных колонок. */
export const BASE_REPORTS = [
  { key: 'revenue',  label: 'Выручка и Продажи',              need: [['клиент', 'контрагент'], ['сумма', 'выручка']] },
  { key: 'cost',     label: 'Себестоимость выпущенной продукции', need: [['продукт', 'номенклат'], ['себест', 'затрат']] },
  { key: 'purchases',label: 'Закупки и партии (РФ + ВЭД)',     need: [['поставщик'], ['сумма', 'цена']] },
  { key: 'warehouse',label: 'Ведомость склада (остатки)',      need: [['номенклат', 'товар'], ['остаток', 'кол-во']] },
  { key: 'opex',     label: 'OPEX / ОСВ (операционные расходы)', need: [['статья', 'расход'], ['сумма']] },
];

const ACCEPTED = ['.xlsx', '.xls', '.csv', '.txt', '.pdf'];

export class DataUploader {
  /**
   * @param {HTMLElement} mount — контейнер для монтирования окна
   * @param {object} ctx — { store, user, engine: BiEngine }
   */
  constructor(mount, ctx) {
    this.mount = mount;
    this.store = ctx.store;
    this.user = ctx.user;
    this.engine = ctx.engine instanceof BiEngine ? ctx.engine : new BiEngine(ctx.store);
    this.templates = ctx.store.get('uploadTemplates') || {};
    this.loaded = {};      // { reportKey: { fileName, rows, headers, status } }
    this.pendingMap = null; // активный диалог ручного сопоставления
  }

  // ── КОНТУР БЕЗОПАСНОСТИ (RBAC): маскировка под 404 ──────────────────────
  canAccess() {
    return !!(this.user && (this.user.is_admin || this.user.has_data_upload_permission));
  }

  render() {
    if (!this.canAccess()) {
      // аппаратная подмена DOM-дерева стандартной ошибкой nginx
      render404(this.mount);
      return;
    }
    this.mount.innerHTML = this._html();
    this._bindDropzones();
  }

  _html() {
    const zones = BASE_REPORTS.map((r) => `
      <div class="uz-drop" data-report="${r.key}">
        <div class="uz-drop-ttl">${r.label}</div>
        <div class="uz-drop-hint">Перетащите файл (.xlsx .csv .pdf) или нажмите</div>
        <div class="uz-progress"><span class="uz-bar"></span></div>
        <input type="file" accept="${ACCEPTED.join(',')}" hidden>
        <span class="uz-check" hidden>✓ Загружено</span>
      </div>`).join('');
    return `
      <div class="uz-grid">${zones}</div>
      <div class="uz-custom" data-report="custom">
        <div class="uz-custom-ttl">📎 Загрузка дополнительных / кастомных форм</div>
        <div class="uz-drop-hint">Любая структура — ИИ распознает колонки автоматически</div>
        <input type="file" accept="${ACCEPTED.join(',')}" hidden>
      </div>
      <div class="uz-maps"></div>
      <button class="uz-run">🚀 Запустить сквозной пересчёт и ИИ-анализ</button>`;
  }

  _bindDropzones() {
    this.mount.querySelectorAll('.uz-drop, .uz-custom').forEach((zone) => {
      const input = zone.querySelector('input[type=file]');
      const report = zone.dataset.report;
      zone.addEventListener('click', () => input.click());
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('uz-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('uz-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault(); zone.classList.remove('uz-over');
        const f = e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) this._onFile(report, f, zone);
      });
      input.addEventListener('change', (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) this._onFile(report, f, zone);
        e.target.value = '';
      });
    });
    this.mount.querySelector('.uz-run').addEventListener('click', () => this._run());
  }

  // ── ЧТЕНИЕ ФАЙЛА (Excel / CSV / TXT / PDF) ──────────────────────────────
  async _onFile(report, file, zone) {
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    if (!ACCEPTED.includes(ext)) { showToast('Формат не поддерживается: ' + ext); return; }
    const bar = zone.querySelector('.uz-bar');
    if (bar) bar.style.width = '30%';
    try {
      const { headers, rows } = await this.readAnyFile(file);
      if (bar) bar.style.width = '70%';
      if (report === 'custom') {
        // семантический маппинг + диалог ручной корректировки
        this._openMappingDialog(file.name, headers, rows);
      } else {
        this.loaded[report] = { fileName: file.name, headers, rows, status: 'ok' };
        const check = zone.querySelector('.uz-check');
        if (check) check.hidden = false;
      }
      if (bar) bar.style.width = '100%';
    } catch (err) {
      showToast('Ошибка чтения «' + file.name + '»: ' + (err.message || err));
      if (bar) bar.style.width = '0%';
    }
  }

  /** Диспетчер: PDF → pdfToRows, остальное → spreadsheetToRows. */
  async readAnyFile(file) {
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    if (ext === '.pdf') return this.pdfToRows(file);
    return this.spreadsheetToRows(file);
  }

  /** Excel/CSV/TXT через SheetJS, поиск строки заголовка, очистка шума. */
  async spreadsheetToRows(file) {
    const ext = '.' + (file.name.split('.').pop() || '').toLowerCase();
    if (ext === '.csv' || ext === '.txt') {
      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
      const head = lines[0] || '';
      const delim = head.indexOf('\t') >= 0 ? '\t' : (head.split(';').length > head.split(',').length ? ';' : ',');
      const parse = (l) => l.split(delim).map((c) => c.replace(/^"|"$/g, '').trim());
      const headers = parse(head);
      const rows = cleanNoiseRows(lines.slice(1).map(parse));
      return { headers, rows };
    }
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('Библиотека SheetJS (XLSX) не загрузилась');
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
    let hr = 0;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      const c = (aoa[i] || []).filter((x) => x != null && String(x).trim()).length;
      if (c >= 2) { hr = i; break; }
    }
    const headers = (aoa[hr] || []).map((x) => String(x == null ? '' : x).trim());
    const rows = cleanNoiseRows(aoa.slice(hr + 1).filter((r) => r && r.some((x) => x != null && String(x).trim())));
    return { headers, rows };
  }

  /**
   * ДВУХЭТАПНЫЙ ПАРСИНГ PDF.
   * Этап 1 — текстовый слой (PDF.js): извлекаем текст и группируем в строки/колонки.
   * Этап 2 — OCR (Tesseract.js): если текстового слоя нет (скан), рендерим страницу
   *          в canvas и распознаём изображение, очищаем матрицу от шума.
   */
  async pdfToRows(file) {
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error('PDF.js не загружен');
    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const lines = [];
    let textLayerChars = 0;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);

      // ── ЭТАП 1: текстовый слой ──
      const content = await page.getTextContent();
      textLayerChars += content.items.reduce((s, it) => s + (it.str || '').length, 0);
      // группируем элементы в строки по координате Y (с допуском)
      const byRow = {};
      for (const it of content.items) {
        const y = Math.round(it.transform[5] / 3) * 3; // квантование Y
        (byRow[y] = byRow[y] || []).push({ x: it.transform[4], s: it.str });
      }
      Object.keys(byRow).sort((a, b) => b - a).forEach((y) => {
        const cells = byRow[y].sort((a, b) => a.x - b.x).map((c) => c.s.trim()).filter(Boolean);
        if (cells.length) lines.push(cells);
      });

      // ── ЭТАП 2: OCR, если текстового слоя практически нет (скан) ──
      if (textLayerChars < 20 && window.Tesseract) {
        const viewport = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width; canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const { data: ocr } = await window.Tesseract.recognize(canvas, 'rus+eng');
        ocr.lines.forEach((ln) => {
          const cells = (ln.text || '').split(/\s{2,}|\t|\|/).map((s) => s.trim()).filter(Boolean);
          if (cells.length) lines.push(cells);
        });
      }
    }

    // нормализуем ширину строк, чистим шум, первая значимая строка — заголовок
    const clean = cleanNoiseRows(lines);
    if (!clean.length) throw new Error('Не удалось извлечь таблицу из PDF');
    const headers = clean[0];
    const rows = clean.slice(1);
    return { headers, rows };
  }

  // ── СЕМАНТИЧЕСКИЙ ИИ-МАППИНГ + ДИАЛОГ РУЧНОЙ КОРРЕКТИРОВКИ ──────────────
  _openMappingDialog(fileName, headers, rows) {
    const map = semanticHeaderMap(headers, rows);   // авто-сопоставление синонимов
    const stats = headers.map((_, i) => columnStats(rows, i));
    this.pendingMap = { fileName, headers, rows, map, stats };
    const fields = [
      ['nomen', 'Номенклатура'], ['qty', 'Количество'], ['price', 'Цена'],
      ['sum', 'Сумма'], ['date', 'Дата'], ['supplier', 'Поставщик'], ['client', 'Клиент'],
    ];
    const options = headers.map((h, i) => `<option value="${i}">${h || ('Колонка ' + (i + 1))}</option>`).join('');
    const rowsHtml = fields.map(([f, label]) => `
      <div class="uz-map-row">
        <span>${label}</span>
        <select data-field="${f}">
          <option value="">— не задано —</option>
          ${options.replace(`value="${map[f]}"`, `value="${map[f]}" selected`)}
        </select>
      </div>`).join('');
    const box = this.mount.querySelector('.uz-maps');
    box.innerHTML = `
      <div class="uz-map">
        <div class="uz-map-ttl">ИИ распознал шапку «${fileName}». Проверьте сопоставление:</div>
        ${rowsHtml}
        <div class="uz-map-actions">
          <button class="uz-map-apply">Применить и сохранить шаблон</button>
          <button class="uz-map-cancel">Отмена</button>
        </div>
      </div>`;
    box.querySelectorAll('select').forEach((sel) => {
      sel.addEventListener('change', (e) => {
        const v = e.target.value;
        if (v === '') delete this.pendingMap.map[e.target.dataset.field];
        else this.pendingMap.map[e.target.dataset.field] = Number(v);
      });
    });
    box.querySelector('.uz-map-apply').addEventListener('click', () => this._applyMapping());
    box.querySelector('.uz-map-cancel').addEventListener('click', () => { this.pendingMap = null; box.innerHTML = ''; });
  }

  _applyMapping() {
    const m = this.pendingMap; if (!m) return;
    // сохраняем структуру в JSON-шаблон по сигнатуре заголовков
    const sig = m.headers.map((h) => String(h).toLowerCase().trim()).filter(Boolean).sort().join('|');
    this.templates[sig] = { name: m.fileName.replace(/\.[^.]+$/, ''), map: m.map, fields: Object.keys(m.map).length };
    this.store.set('uploadTemplates', this.templates);
    this.loaded['custom_' + Date.now()] = { fileName: m.fileName, headers: m.headers, rows: m.rows, map: m.map, status: 'ok' };
    this.pendingMap = null;
    this.mount.querySelector('.uz-maps').innerHTML = '';
    showToast('Шаблон «' + m.fileName + '» сохранён ✓');
  }

  // ── ФИНАЛЬНЫЙ КЛИК → ГЛОБАЛЬНЫЙ ДВИЖОК 24/7 ─────────────────────────────
  async _run() {
    // переносим распознанные данные в стор (по контурам)
    for (const key in this.loaded) this.store.ingestReport(key, this.loaded[key]);
    // запускаем строго последовательный каскадный пересчёт
    await this.engine.executeDeepBusinessIntelligence('FULL_RECALC', { mode: 'force' });
    showToast('🚀 Данные загружены, сквозной пересчёт выполнен');
  }
}
