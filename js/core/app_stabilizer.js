/**
 * js/core/app_stabilizer.js
 * ============================================================================
 * SHTARK FLOW · APP STABILIZER — монолитный патч стабилизации боевого режима
 * ============================================================================
 * Назначение: устранить 5 классов конфликтов, проявляющихся на статическом
 * хостинге GitHub Pages (нет бэкенда, асинхронная загрузка CDN, общий стейт
 * двух компаний, глобальные слушатели событий).
 *
 * Самоустанавливается при импорте: `import './core/app_stabilizer.js'` ИЛИ
 * <script src="js/core/app_stabilizer.js"></script>. Все хелперы также
 * публикуются в window.AppStabilizer для адресного вызова из движка.
 *
 * Принцип: НЕ менять физический путь в адресной строке (это и вызывает 404 на
 * GitHub Pages), работать только через hash + переключение видимости DOM,
 * жёстко изолировать контекст компании, локализовать перехватчики безопасности
 * строго внутри приватных чатов и оборачивать вызовы тяжёлых CDN-библиотек
 * защитными guard'ами с понятным статусом ожидания.
 *
 * @module core/app_stabilizer
 */
(function (root) {
  'use strict';

  var AS = {};

  /* ======================================================================== *
   * ЗОНА 1 — ОТКАЗОУСТОЙЧИВЫЙ ХЭШ-РОУТИНГ ДЛЯ GITHUB PAGES (анти-404)
   * ------------------------------------------------------------------------
   * На GitHub Pages любой переход на «реальный» путь (/security-log, /private)
   * уходит на сервер → жёсткая 404, ломающая SPA. Поэтому маршрутизация ТОЛЬКО
   * через location.hash и переключение видимости блоков класса .as-route.
   * Физический pathname НИКОГДА не меняется.
   * ======================================================================== */
  AS.Router = (function () {
    var routes = {};        // hash -> { onEnter, guard }
    var current = '';
    var defaultRoute = 'home';

    function normalize(h) {
      h = String(h || '').replace(/^#/, '').trim();
      // отрезаем GET-параметры из хэша (#tab?x=1) — берём только имя маршрута
      var q = h.indexOf('?');
      return (q >= 0 ? h.slice(0, q) : h) || defaultRoute;
    }

    function params() {
      var h = String(location.hash || '');
      var q = h.indexOf('?');
      var out = {};
      if (q >= 0) new URLSearchParams(h.slice(q + 1)).forEach(function (v, k) { out[k] = v; });
      return out;
    }

    function go(name, opts) {
      // безопасная навигация: только хэш, без pushState реального пути
      var target = normalize(name);
      var route = routes[target];
      if (route && typeof route.guard === 'function' && !route.guard()) {
        // доступ запрещён → НЕ редиректим на /404, а показываем DOM-маску 404
        AS.render404(document.querySelector('[data-route="' + target + '"]') || document.body);
        return false;
      }
      if (('#' + target) !== location.hash) {
        try { location.hash = target; } catch (e) { /* старые браузеры */ }
      }
      activate(target);
      return true;
    }

    function activate(target) {
      current = target;
      // переключаем видимость через классы hidden/display, НЕ трогая pathname
      var blocks = document.querySelectorAll('.as-route');
      for (var i = 0; i < blocks.length; i++) {
        var b = blocks[i];
        var on = b.getAttribute('data-route') === target;
        b.classList.toggle('as-hidden', !on);
        if (on) b.removeAttribute('hidden'); else b.setAttribute('hidden', '');
      }
      var r = routes[target];
      if (r && typeof r.onEnter === 'function') { try { r.onEnter(params()); } catch (e) {} }
    }

    function register(name, handlers) { routes[normalize(name)] = handlers || {}; }
    function setDefault(name) { defaultRoute = normalize(name); }

    function start() {
      window.addEventListener('hashchange', function () { activate(normalize(location.hash)); });
      // первичная активация — текущий хэш либо дефолт; pathname остаётся как есть
      activate(normalize(location.hash));
    }

    return { register: register, go: go, start: start, setDefault: setDefault, params: params, normalize: normalize, get current() { return current; } };
  })();

  /** DOM-маска «404» БЕЗ ухода с SPA (для закрытых по правам разделов). */
  AS.render404 = function (mount) {
    if (!mount) return;
    mount.innerHTML =
      '<div class="err404" style="max-width:560px;margin:40px auto;font-family:\'Times New Roman\',serif;color:#000">' +
      '<h1 style="font-size:26px;margin:0 0 6px">404 Not Found</h1>' +
      '<p>The requested URL was not found on this server.</p>' +
      '<hr style="border:none;border-top:1px solid #ccc;margin:10px 0">' +
      '<div style="color:#666;font-size:13px">nginx</div></div>';
  };

  /* ======================================================================== *
   * ЗОНА 2 — АНТИ-ГОНКИ И АНТИ-NaN ДЛЯ ДВИЖКА ПЕРЕСЧЁТА 24/7
   * ------------------------------------------------------------------------
   * Каскад линеаризуется мьютексом + очередью: пересчёт, запрошенный во время
   * пересчёта, откладывается (не рекурсит). Все денежные расчёты проходят через
   * safeDiv/num → деление на ноль и undefined дают 0, а не NaN.
   * ======================================================================== */

  /** Числовой каст: '' / null / NaN / Infinity → 0. */
  AS.num = function (v) {
    if (v == null || v === '') return 0;
    var n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : 0;
  };

  /** Безопасное деление: знаменатель 0/невалиден → fallback (0 по умолчанию). */
  AS.safeDiv = function (a, b, fallback) {
    a = AS.num(a); b = AS.num(b);
    if (b === 0) return fallback == null ? 0 : fallback;
    var r = a / b;
    return isFinite(r) ? r : (fallback == null ? 0 : fallback);
  };

  /** Удельный показатель «на 1 кг» с защитой от нулевого веса (возвращает 0). */
  AS.perKg = function (amount, weightKg) { return AS.safeDiv(amount, weightKg, 0); };

  /**
   * Мьютекс каскада: строго один проход одновременно, остальное — в очередь.
   * @param {Function} task — async-функция слоя/каскада
   */
  AS.Cascade = (function () {
    var running = false;
    var queued = null;
    async function run(task) {
      if (typeof task !== 'function') return null;
      if (running) { queued = task; return null; }      // не рекурсим — откладываем
      running = true;
      var result = null;
      try {
        result = await task();                          // железное ожидание слоёв
      } catch (e) {
        try { console.warn('[AppStabilizer] cascade layer error:', e && e.message); } catch (_) {}
      } finally {
        running = false;
        if (queued) { var q = queued; queued = null; setTimeout(function () { run(q); }, 0); }
      }
      return result;
    }
    return { run: run, get busy() { return running; } };
  })();

  /**
   * Линеаризатор слоёв: выполняет слои СТРОГО последовательно с await; падение
   * одного слоя не роняет каскад (try/catch на каждом), маржа не стартует, пока
   * не готовы Landed Cost и план производства.
   * @param {Array<{name:string, fn:Function}>} layers
   */
  AS.runLayers = async function (layers) {
    var ctx = {};
    for (var i = 0; i < (layers || []).length; i++) {
      var L = layers[i];
      try { ctx[L.name] = await L.fn(ctx); }
      catch (e) { ctx[L.name] = null; try { console.warn('[AppStabilizer] layer "' + L.name + '" failed:', e && e.message); } catch (_) {} }
      await new Promise(function (r) { (typeof queueMicrotask === 'function' ? queueMicrotask : setTimeout)(r, 0); });
    }
    return ctx;
  };

  /* ======================================================================== *
   * ЗОНА 3 — ИЗОЛЯЦИЯ КОНТЕКСТА ДВУХ КОМПАНИЙ И ВАЛЮТ
   * ------------------------------------------------------------------------
   * Жёсткий scope текущей компании: ключи кэша префиксуются company_id, при
   * смене компании/валюты контекст обнуляется перед перерисовкой — данные
   * одной компании не «протекают» в отчёты другой.
   * ======================================================================== */
  AS.Scope = (function () {
    var companyId = null;
    var currency = 'RUB';
    var vat = 'WITH';
    var cache = {};

    function key(name) { return (companyId || '_') + '::' + name; }

    function setCompany(id) {
      if (id === companyId) return false;
      companyId = id;
      cache = {};                  // полное обнуление кэша при смене компании
      return true;                 // caller обязан перерисовать DOM заново
    }
    function setCurrency(cur) { if (cur !== currency) { currency = cur; cache = {}; return true; } return false; }
    function setVat(mode) { if (mode !== vat) { vat = mode; cache = {}; return true; } return false; }

    /** Изолированный массив строк отчёта: только записи активной компании. */
    function isolate(rows, idField) {
      idField = idField || 'company_id';
      if (!Array.isArray(rows)) return [];
      return rows.filter(function (r) {
        var c = r && (r[idField] != null ? r[idField] : r._co);
        return c == null || c === companyId; // null = общая запись, иначе строгий матч
      });
    }

    function memo(name, producer) {
      var k = key(name + '|' + currency + '|' + vat);
      if (cache[k] === undefined) cache[k] = producer();
      return cache[k];
    }
    function flush() { cache = {}; }

    return {
      setCompany: setCompany, setCurrency: setCurrency, setVat: setVat,
      isolate: isolate, memo: memo, flush: flush,
      get companyId() { return companyId; }, get currency() { return currency; }, get vat() { return vat; }
    };
  })();

  /**
   * Глобальный конвертер представления (НЕ мутирует исходные RUB-данные):
   * приводит массив любого отчёта к выбранной валюте/контуру/удельности.
   * @param {Array<object>} rows
   * @param {{rateEur:number}} rates
   * @param {'RUB'|'EUR'} curMode
   * @param {'WITH'|'WITHOUT'} vatMode
   * @param {boolean} isUnitPerKg
   */
  AS.convertFinancialData = function (rows, rates, curMode, vatMode, isUnitPerKg) {
    var rate = AS.num(rates && rates.rateEur) || 1;
    var moneyFields = ['revenue', 'cost', 'gm1', 'gm2', 'opex', 'landed', 'invoice', 'extra'];
    return (rows || []).map(function (r) {
      var out = {};
      for (var k in r) out[k] = r[k];               // копия — исходник не трогаем
      for (var i = 0; i < moneyFields.length; i++) {
        var f = moneyFields[i];
        if (out[f] == null) continue;
        var v = AS.num(out[f]);
        if (vatMode === 'WITHOUT' && out.vat_rate) v = v / (1 + AS.num(out.vat_rate));
        if (curMode === 'EUR') v = AS.safeDiv(v, rate, 0);
        if (isUnitPerKg) v = AS.perKg(v, out.weight_kg);
        out[f] = v;
      }
      return out;
    });
  };

  /* ======================================================================== *
   * ЗОНА 4 — ЛОКАЛИЗАЦИЯ ПЕРЕХВАТЧИКОВ БЕЗОПАСНОСТИ (ТОЛЬКО ПРИВАТНЫЕ ЧАТЫ)
   * ------------------------------------------------------------------------
   * Запрет copy / contextmenu / Ctrl+C вешается на document с делегированием,
   * но preventDefault срабатывает ТОЛЬКО если событие произошло внутри
   * контейнера приватного чата. Везде — задачи, закупки, калькулятор, общий
   * чат — стандартное поведение браузера сохраняется на 100%.
   * ======================================================================== */
  AS.SecurityGuards = (function () {
    var SELECTOR = '.private-chat-messages-container, [data-private-chat="1"]';
    var installed = false;
    var onIncident = null;

    function inPrivate(el) {
      return !!(el && el.closest && el.closest(SELECTOR));
    }
    function fire(type) { if (typeof onIncident === 'function') { try { onIncident(type); } catch (e) {} } }

    function install(incidentCb) {
      if (installed) return;
      installed = true;
      onIncident = incidentCb || null;

      document.addEventListener('copy', function (e) {
        if (inPrivate(e.target)) { e.preventDefault(); fire('DATA_THEFT_ATTEMPT:copy'); }
        // вне приватного чата — НИЧЕГО не делаем, копирование работает штатно
      }, true);

      document.addEventListener('contextmenu', function (e) {
        if (inPrivate(e.target)) { e.preventDefault(); fire('DATA_THEFT_ATTEMPT:context'); }
      }, true);

      document.addEventListener('keydown', function (e) {
        var isCopyCut = (e.ctrlKey || e.metaKey) && ['c', 'x', 'C', 'X'].indexOf(e.key) >= 0;
        if (isCopyCut && inPrivate(document.activeElement || e.target)) { fire('DATA_THEFT_ATTEMPT:hotkey'); }
        // НЕ блокируем ввод цифр/букв и Ctrl+C нигде, кроме приватного чата
      }, true);
    }
    return { install: install, inPrivate: inPrivate };
  })();

  /* ======================================================================== *
   * ЗОНА 5 — GUARD'Ы ДЛЯ ТЯЖЁЛЫХ CDN-БИБЛИОТЕК (SheetJS / PDF.js / Tesseract)
   * ------------------------------------------------------------------------
   * Перед любым парсингом проверяем готовность объекта. Если библиотека ещё
   * грузится — показываем понятный статус и ДОЖИДАЕМСЯ (поллинг с таймаутом),
   * вместо краша «XLSX is not a function».
   * ======================================================================== */
  AS.Lib = (function () {
    var SOURCES = {
      XLSX: 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js',
      pdfjsLib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
      Tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'
    };
    var STATUS = {
      XLSX: 'Инициализация модуля Excel (SheetJS)…',
      pdfjsLib: 'Инициализация ИИ-компонентов распознавания PDF…',
      Tesseract: 'Инициализация OCR-движка распознавания сканов…'
    };
    var loading = {};

    function present(name) { return typeof root[name] !== 'undefined' && root[name]; }

    function injectOnce(name) {
      if (present(name) || loading[name]) return loading[name] || Promise.resolve(root[name]);
      loading[name] = new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = SOURCES[name]; s.async = true;
        s.onload = function () {
          if (name === 'pdfjsLib') {
            try { root.pdfjsLib.GlobalWorkerOptions.workerSrc = SOURCES.pdfjsLib.replace('pdf.min.js', 'pdf.worker.min.js'); } catch (e) {}
          }
          res(root[name]);
        };
        s.onerror = function () { rej(new Error(name + ': библиотека не загрузилась (CDN недоступен)')); };
        document.head.appendChild(s);
      });
      return loading[name];
    }

    /**
     * Гарантированно получить библиотеку: если есть — сразу; если грузится —
     * показать статус через statusCb и дождаться; таймаут по умолчанию 20 с.
     * @returns {Promise<object>}
     */
    function ensure(name, statusCb, timeoutMs) {
      if (present(name)) return Promise.resolve(root[name]);
      if (typeof statusCb === 'function') statusCb(STATUS[name] || ('Инициализация ' + name + '…'));
      var p = injectOnce(name);
      var limit = timeoutMs || 20000;
      var timeout = new Promise(function (_, rej) { setTimeout(function () { rej(new Error(name + ': превышено время ожидания инициализации')); }, limit); });
      return Promise.race([p, timeout]).then(function () {
        if (typeof statusCb === 'function') statusCb('');
        if (!present(name)) throw new Error(name + ': объект не инициализирован');
        return root[name];
      });
    }

    /** Синхронная проверка «можно ли вызывать сейчас» (для быстрых веток). */
    function ready(name) { return !!present(name); }

    return { ensure: ensure, ready: ready, STATUS: STATUS };
  })();

  /* ======================================================================== *
   * БУТСТРАП — безопасная инициализация при загрузке страницы
   * ======================================================================== */
  AS.bootstrap = function (opts) {
    opts = opts || {};
    // 1) роутинг — только хэш, pathname не трогаем (анти-404 GitHub Pages)
    if (opts.routes) { for (var name in opts.routes) AS.Router.register(name, opts.routes[name]); }
    if (opts.defaultRoute) AS.Router.setDefault(opts.defaultRoute);
    if (opts.startRouter !== false) AS.Router.start();
    // 2) перехватчики безопасности — строго внутри приватных чатов
    if (opts.securityIncident !== false) AS.SecurityGuards.install(opts.onSecurityIncident);
    // 3) изоляция компании
    if (opts.companyId) AS.Scope.setCompany(opts.companyId);
    try { console.info('[AppStabilizer] инициализирован: hash-router, company-scope, security-guards, lib-guards, safe-math.'); } catch (e) {}
    return AS;
  };

  // экспорт
  root.AppStabilizer = AS;
  if (typeof module !== 'undefined' && module.exports) module.exports = AS;

  // авто-установка перехватчиков безопасности (идемпотентно), без авто-старта роутера
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { AS.SecurityGuards.install(); });
    } else { AS.SecurityGuards.install(); }
  }
})(typeof window !== 'undefined' ? window : this);
