/**
 * js/core/mail_parser.js
 * ============================================================================
 * ПОЧТОВЫЙ РОБОТ ИИ-КОННЕКТ — мультикомпанийный входящий шлюз документов
 * ============================================================================
 * Два входящих ящика → два контура учёта:
 *   • Ящик №1 (inbox-1@…)  → Компания №1, ПАРТИОННЫЙ учёт (Landed Cost).
 *   • Ящик №2 (inbox-2@…)  → Компания №2, FIFO по выпускам.
 *
 * Алгоритм «Парсить до победы»: до 5 итераций глубокого семантического анализа
 * (Excel/Word/PDF/CSV/HTML) с очисткой шума, поиском объединённых ячеек и
 * отсечением подвалов. Успех → занос в базу + движок 24/7 + сообщение в чат
 * со звуком. Отказ → брендированное письмо отправителю через NodeMailer.
 *
 * Эта серверная логика разворачивается как фоновый воркер (Node.js), который
 * читает IMAP и дергает тот же executeDeepBusinessIntelligence, что и фронтенд.
 *
 * @module core/mail_parser
 */

import { BiEngine } from './bi_engine.js';
import { semanticHeaderMap, cleanNoiseRows, detectInvoice } from '../data/ingest_1c.js';

/** Привязка ящик → компания + метод учёта. */
export const MAILBOX_ROUTES = {
  'inbox-1@shtarkflow.ru': { companyId: 'company_1', companyName: 'Компания №1', costMethod: 'batch' },
  'inbox-2@shtarkflow.ru': { companyId: 'company_2', companyName: 'Компания №2', costMethod: 'fifo' },
};

const MAX_ITERATIONS = 5;

export class MailParser {
  /**
   * @param {object} ctx — {
   *   store, engine: BiEngine,
   *   imap:   { fetchUnread(mailbox): Promise<Array<{from,subject,attachments:[{name,buffer,mime}]}>> },
   *   mailer: { send({to,subject,html}): Promise<void> },     // NodeMailer-обёртка
   *   chat:   { post({text, sound}): void },
   *   readers:{ xlsx(buf), csv(buf), docx(buf), pdf(buf), html(buf) }  // парсеры форматов
   * }
   */
  constructor(ctx) {
    this.store = ctx.store;
    this.engine = ctx.engine instanceof BiEngine ? ctx.engine : new BiEngine(ctx.store);
    this.imap = ctx.imap;
    this.mailer = ctx.mailer;
    this.chat = ctx.chat;
    this.readers = ctx.readers;
  }

  /** Главный цикл воркера: обходит все ящики и обрабатывает новые письма. */
  async poll() {
    for (const mailbox of Object.keys(MAILBOX_ROUTES)) {
      const route = MAILBOX_ROUTES[mailbox];
      let messages = [];
      try { messages = await this.imap.fetchUnread(mailbox); } catch (e) { continue; }
      for (const msg of messages) {
        for (const att of (msg.attachments || [])) {
          await this._handleAttachment(att, route, msg.from);
        }
      }
    }
  }

  /** Обработка одного вложения: «парсить до победы» → успех/отказ. */
  async _handleAttachment(att, route, fromEmail) {
    const parsed = await this._parseUntilWin(att);
    if (parsed && parsed.rows && parsed.rows.length) {
      // ── УСПЕХ ──
      this.store.ingestDocument({
        companyId: route.companyId,
        costMethod: route.costMethod,
        headers: parsed.headers,
        rows: parsed.rows,
        map: parsed.map,
        source: 'mail:' + route.companyId,
        fileName: att.name,
      });
      // фоновый движок 24/7 (каскад маржи по FIFO или партиям)
      await this.engine.executeDeepBusinessIntelligence('FULL_RECALC', { mode: 'force' });
      // сообщение в чат со звуком
      this.chat.post({
        text: '📩 ИИ-Коннект: Новый документ «' + att.name + '» успешно распознан и отражён по «' + route.companyName + '».',
        sound: 'autopilot',
      });
    } else {
      // ── ОТКАЗ ── брендированное письмо отправителю через NodeMailer
      await this._sendFailureEmail(fromEmail, att.name);
    }
  }

  /**
   * АЛГОРИТМ «ПАРСИТЬ ДО ПОБЕДЫ»: до 5 итераций с разными стратегиями очистки.
   * Возвращает { headers, rows, map } при успехе, либо null.
   */
  async _parseUntilWin(att) {
    const ext = '.' + (att.name.split('.').pop() || '').toLowerCase();
    let raw;
    try { raw = await this._readByFormat(ext, att.buffer); } catch (e) { return null; }
    if (!raw || !raw.length) return null;

    // стратегии очистки, применяемые по итерациям
    const strategies = [
      (m) => m,                                              // как есть
      (m) => cleanNoiseRows(m),                              // убрать пустые строки/подвалы
      (m) => this._expandMergedCells(cleanNoiseRows(m)),     // развернуть объединённые ячейки
      (m) => this._trimFooter(this._expandMergedCells(m)),   // отсечь подвал баланса
      (m) => this._normalizeWidth(this._trimFooter(m)),      // выровнять ширину строк
    ];

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const matrix = strategies[Math.min(i, strategies.length - 1)](raw.slice());
      if (!matrix.length) continue;
      const headers = matrix[0].map((c) => String(c == null ? '' : c).trim());
      const rows = matrix.slice(1);
      const map = semanticHeaderMap(headers, rows);
      // победа, если распознали номенклатуру и хотя бы одну числовую метрику
      const ok = map.nomen != null && (map.qty != null || map.sum != null || map.price != null);
      if (ok) return { headers, rows, map, iterations: i + 1 };
      // дополнительная попытка трактовать как инвойс
      const inv = detectInvoice(headers, rows);
      if (inv && inv.confident) return { headers, rows: inv.itemsAsRows, map: inv.map, iterations: i + 1 };
    }
    return null;
  }

  /** Чтение по формату через инжектированные ридеры. */
  async _readByFormat(ext, buffer) {
    switch (ext) {
      case '.xlsx': case '.xls': return this.readers.xlsx(buffer);
      case '.csv':  return this.readers.csv(buffer);
      case '.docx': return this.readers.docx(buffer);
      case '.pdf':  return this.readers.pdf(buffer);
      case '.html': case '.htm': return this.readers.html(buffer);
      default: throw new Error('Неподдерживаемый формат: ' + ext);
    }
  }

  // ── стратегии очистки матрицы ───────────────────────────────────────────

  /** Разворачивает объединённые ячейки: пустые ячейки наследуют значение слева. */
  _expandMergedCells(matrix) {
    return matrix.map((row) => {
      const out = []; let last = '';
      for (const cell of row) {
        const v = cell == null || String(cell).trim() === '' ? last : String(cell).trim();
        out.push(v); if (v) last = v;
      }
      return out;
    });
  }

  /** Отсекает подвал отчёта (строки с «Итого/Подпись/Бухгалтер» после данных). */
  _trimFooter(matrix) {
    const footer = /^(итого|всего|подпис|бухгалтер|руководител|м\.п\.|страница)/i;
    let end = matrix.length;
    for (let i = matrix.length - 1; i >= 0; i--) {
      const joined = (matrix[i] || []).join(' ').toLowerCase().trim();
      if (footer.test(joined)) end = i; else if (joined) break;
    }
    return matrix.slice(0, end);
  }

  /** Выравнивает ширину строк по самой длинной (для PDF/OCR-матриц). */
  _normalizeWidth(matrix) {
    const w = matrix.reduce((m, r) => Math.max(m, r.length), 0);
    return matrix.map((r) => { const c = r.slice(); while (c.length < w) c.push(''); return c; });
  }

  /** Брендированное письмо-отказ через NodeMailer. */
  async _sendFailureEmail(to, fileName) {
    if (!to) return;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e7e4e0;border-radius:12px;overflow:hidden">
        <div style="background:#1F4E78;color:#fff;padding:16px 22px;font-weight:700;font-size:16px">Shtark Flow · ИИ-Коннект</div>
        <div style="padding:22px;color:#2b2926;font-size:14px;line-height:1.6">
          <p><b>Внимание!</b> Роботу Shtark Flow не удалось распознать документ
          «${fileName}» после ${MAX_ITERATIONS} попыток семантического анализа.</p>
          <p>Пожалуйста, внесите документ в базу системы Shtark Flow вручную через
          защищённое <b>Окно загрузки данных</b>.</p>
        </div>
        <div style="background:#f6f3ef;padding:12px 22px;color:#8a8782;font-size:12px">
          Это автоматическое уведомление. Не отвечайте на него.
        </div>
      </div>`;
    try {
      await this.mailer.send({ to, subject: 'Shtark Flow: документ не распознан — требуется ручная загрузка', html });
    } catch (e) { /* письмо не критично — лог на стороне воркера */ }
  }
}
