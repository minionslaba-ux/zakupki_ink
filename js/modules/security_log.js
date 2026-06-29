/**
 * js/modules/security_log.js
 * ============================================================================
 * СКРЫТЫЙ ЖУРНАЛ БЕЗОПАСНОСТИ (Audit Trail) — только для администраторов
 * ============================================================================
 * RBAC: is_admin === true. Для остальных — аппаратная подмена DOM на 404.
 * Принимает и рендерит инциденты безопасности; критические — пастельно-красным.
 * Живой поиск по ID/имени сотрудника.
 *
 * @module modules/security_log
 */

/** Стандартная маскировка под ошибку nginx (используется во всех закрытых модулях). */
export function render404(mount) {
  mount.innerHTML = `
    <div class="err404">
      <h1>404 Not Found</h1>
      <p>The requested URL was not found on this server.</p>
      <hr>
      <div class="err404-addr">nginx</div>
    </div>`;
}

/** Каталог категорий угроз и человекочитаемых описаний событий. */
const THREAT = {
  PARALLEL_SESSION_ATTEMPT: { level: 'crit', label: 'Критично', desc: 'Параллельная сессия: вход со второго устройства', status: 'Перехвачено' },
  PERIMETER_VIOLATION:      { level: 'warn', label: 'Предупреждение', desc: 'Попытка открыть Окно загрузки без прав', status: 'Заблокировано' },
  DATA_THEFT_ATTEMPT:       { level: 'crit', label: 'Критично', desc: 'Попытка копирования данных в приватном чате (Ctrl+C / ПКМ)', status: 'Перехвачено' },
  AI_SELF_DESTRUCT_LOG:     { level: 'info', label: 'Инфо', desc: 'Авто-удаление приватного чата (48 ч) / общего (30 дн)', status: 'Выполнено' },
};

export class SecurityLog {
  /** @param {HTMLElement} mount @param {object} ctx — { store, user } */
  constructor(mount, ctx) {
    this.mount = mount;
    this.store = ctx.store;
    this.user = ctx.user;
    this.search = '';
    this._installInterceptors(ctx);
  }

  isAdmin() { return !!(this.user && this.user.is_admin); }

  /** Прочитать журнал из стора (персист в localStorage/cloud). */
  entries() { return this.store.get('securityLog') || []; }

  /**
   * Зарегистрировать инцидент. Принимает JSON-событие одного из известных типов.
   * @param {string} type — ключ THREAT
   * @param {object} [payload] — { userId, userName, detail }
   */
  log(type, payload = {}) {
    const meta = THREAT[type] || { level: 'info', label: 'Инфо', desc: type, status: '—' };
    const entry = {
      id: 'sec_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      ts: Date.now(),
      type,
      userId: payload.userId || (this.user ? this.user.id : '—'),
      userName: payload.userName || (this.user ? this.user.name : '—'),
      level: meta.level,
      levelLabel: meta.label,
      description: payload.detail ? meta.desc + ' · ' + payload.detail : meta.desc,
      status: meta.status,
    };
    const log = [entry, ...this.entries()].slice(0, 500);
    this.store.set('securityLog', log);
    if (this.isAdmin() && this.mount && this.mount.querySelector('.seclog-body')) this.render();
    return entry;
  }

  // ── ОБРАБОТЧИКИ-LISTENERS (аппаратные перехватчики событий) ─────────────
  _installInterceptors(ctx) {
    if (typeof document === 'undefined') return;

    // DATA_THEFT_ATTEMPT — Ctrl+C / Cmd+C / ПКМ внутри приватных чатов (user-select:none)
    const inPrivateChat = (el) => !!(el && el.closest && el.closest('[data-private-chat]'));
    document.addEventListener('copy', (e) => {
      if (inPrivateChat(e.target)) {
        e.preventDefault();
        this.log('DATA_THEFT_ATTEMPT', { detail: 'copy' });
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && inPrivateChat(document.activeElement)) {
        this.log('DATA_THEFT_ATTEMPT', { detail: 'hotkey' });
      }
    }, true);
    document.addEventListener('contextmenu', (e) => {
      if (inPrivateChat(e.target)) { e.preventDefault(); this.log('DATA_THEFT_ATTEMPT', { detail: 'context-menu' }); }
    }, true);

    // PARALLEL_SESSION_ATTEMPT — приходит из слоя сессий (cloud.js) через колбэк
    if (ctx.onParallelSession) ctx.onParallelSession((info) => this.log('PARALLEL_SESSION_ATTEMPT', info));
    // PERIMETER_VIOLATION — из RBAC-гейта закрытых окон
    if (ctx.onPerimeterViolation) ctx.onPerimeterViolation((info) => this.log('PERIMETER_VIOLATION', info));
    // AI_SELF_DESTRUCT_LOG — из планировщика авто-удаления чатов
    if (ctx.onSelfDestruct) ctx.onSelfDestruct((info) => this.log('AI_SELF_DESTRUCT_LOG', info));
  }

  // ── РЕНДЕР ТАБЛИЦЫ ЛОГОВ ────────────────────────────────────────────────
  render() {
    if (!this.isAdmin()) { render404(this.mount); return; }
    const q = this.search.trim().toLowerCase();
    const rows = this.entries().filter((e) =>
      !q || String(e.userId).toLowerCase().includes(q) || String(e.userName).toLowerCase().includes(q)
    );
    this.mount.innerHTML = `
      <div class="seclog">
        <div class="seclog-head">
          <span class="seclog-ttl">🔒 Журнал безопасности · Audit Trail</span>
          <input class="seclog-search" placeholder="Поиск по ID или имени сотрудника…" value="${this.search}">
        </div>
        <div class="seclog-tbl">
          <div class="seclog-hd">
            <span>Таймстамп</span><span>Пользователь</span><span>Угроза</span>
            <span>Описание действия</span><span>Статус</span>
          </div>
          <div class="seclog-body">
            ${rows.map((e) => this._rowHtml(e)).join('') || '<div class="seclog-empty">Событий безопасности нет.</div>'}
          </div>
        </div>
      </div>`;
    const input = this.mount.querySelector('.seclog-search');
    input.addEventListener('input', (e) => { this.search = e.target.value; this._renderBodyOnly(); });
  }

  _renderBodyOnly() {
    const q = this.search.trim().toLowerCase();
    const rows = this.entries().filter((e) =>
      !q || String(e.userId).toLowerCase().includes(q) || String(e.userName).toLowerCase().includes(q)
    );
    const body = this.mount.querySelector('.seclog-body');
    if (body) body.innerHTML = rows.map((e) => this._rowHtml(e)).join('') || '<div class="seclog-empty">Ничего не найдено.</div>';
  }

  _rowHtml(e) {
    const cls = e.level === 'crit' ? 'seclog-row crit' : (e.level === 'warn' ? 'seclog-row warn' : 'seclog-row');
    const when = new Date(e.ts).toLocaleString('ru-RU');
    return `
      <div class="${cls}">
        <span class="seclog-ts">${when}</span>
        <span class="seclog-user">${e.userName} · ${e.userId}</span>
        <span class="seclog-badge l-${e.level}">${e.levelLabel}</span>
        <span class="seclog-desc">${e.description}</span>
        <span class="seclog-status">${e.status}</span>
      </div>`;
  }
}

/** CSS модуля (инжектится один раз). */
export const SECURITY_LOG_CSS = `
.err404{max-width:560px;margin:40px auto;font-family:'Times New Roman',serif;color:#000}
.err404 h1{font-size:26px;margin:0 0 6px}.err404 hr{border:none;border-top:1px solid #ccc;margin:10px 0}
.err404-addr{color:#666;font-size:13px}
.seclog-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.seclog-ttl{font-size:15px;font-weight:800;color:#1a2b3c}
.seclog-search{border:1px solid #d6d2cc;border-radius:9px;padding:8px 12px;font-size:13px;min-width:260px}
.seclog-tbl{border:1px solid #e7e4e0;border-radius:11px;overflow:hidden}
.seclog-hd,.seclog-row{display:grid;grid-template-columns:160px 1.4fr 110px 2.2fr 130px;gap:10px;align-items:center;padding:9px 14px}
.seclog-hd{background:#f6f3ef;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.03em;color:#8a8782}
.seclog-row{border-top:1px solid #f0ece6;font-size:12.5px;transition:transform .12s ease,box-shadow .12s ease}
.seclog-row:hover{transform:translateY(-2px);box-shadow:0 6px 16px rgba(0,0,0,.07)}
.seclog-row.crit{color:#c0322b;background:#fdf6f5}
.seclog-row.warn{background:#fdfaf3}
.seclog-ts{font-family:'IBM Plex Mono',monospace;color:#8a8782;font-size:11px}
.seclog-badge{font-size:10px;font-weight:800;border-radius:20px;padding:2px 9px;text-align:center}
.seclog-badge.l-crit{background:#fce0de;color:#c0322b}
.seclog-badge.l-warn{background:#fdeccb;color:#9a5a1c}
.seclog-badge.l-info{background:#e3eef9;color:#1F4E78}
.seclog-status{font-weight:700;font-size:11.5px}
.seclog-empty{padding:24px;text-align:center;color:#9a9793}
`;
