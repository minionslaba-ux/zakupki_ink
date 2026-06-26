"""Курсы валют ЦБ РФ — порт логики из Google Apps Script (версия v7).

Источник по приоритету (как в исходном скрипте):

1. Официальный XML ЦБ РФ — ``https://www.cbr.ru/scripts/XML_daily.asp``
   (кодировка windows-1251, запятая как десятичный разделитель, учёт
   ``<Nominal>``);
2. Зеркало ``cbr-xml-daily.ru`` (JSON, есть архив по датам);
3. Зеркало ``cbr-xml-daily.com`` (JSON, без архива).

Используется только стандартная библиотека (``urllib``), внешних
зависимостей не требуется.
"""

from __future__ import annotations

import json
import re
import urllib.request
from dataclasses import dataclass
from datetime import date

# Источники курсов.
CBR_OFFICIAL = "https://www.cbr.ru/scripts/XML_daily.asp"
CBR_MIRROR_RU = "https://www.cbr-xml-daily.ru/daily_json.js"
CBR_MIRROR_RU_ARC = "https://www.cbr-xml-daily.ru/archive/"
CBR_MIRROR_COM = "https://www.cbr-xml-daily.com/daily_json.js"

_TIMEOUT = 15  # секунд на запрос


@dataclass(slots=True)
class CbrRates:
    """Курсы ЦБ на одну дату (к рублю).

    :param date: дата в формате ``YYYY-MM-DD``;
    :param eur: курс EUR/RUB;
    :param usd: курс USD/RUB;
    :param cny: курс CNY/RUB (``0`` если отсутствует).
    """

    date: str
    eur: float
    usd: float
    cny: float = 0.0

    @property
    def eur_usd(self) -> float:
        """Кросс-курс EUR/USD."""
        return self.eur / self.usd if self.usd else 0.0

    @property
    def eur_cny(self) -> float:
        """Кросс-курс EUR/CNY."""
        return self.eur / self.cny if self.cny else 0.0


class RateFetchError(RuntimeError):
    """Ни один источник курсов не ответил."""


# ----------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------
def _http_get(url: str) -> bytes:
    """GET-запрос, возвращает тело ответа в виде байтов."""
    req = urllib.request.Request(url, headers={"User-Agent": "nev-calc/1.0"})
    with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:  # noqa: S310
        if resp.status != 200:
            raise RateFetchError(f"HTTP {resp.status} для {url}")
        return resp.read()


# ----------------------------------------------------------------------
# Источник 1: официальный XML ЦБ РФ
# ----------------------------------------------------------------------
def _extract_cbr_value(xml_text: str, code: str) -> float | None:
    """Извлечь курс валюты ``code`` из XML с учётом ``<Nominal>``.

    Воспроизводит функцию ``extractCbrValue`` из Apps Script.
    """
    block = re.search(
        r"<Valute[^>]*>.*?<CharCode>" + re.escape(code) + r"</CharCode>.*?</Valute>",
        xml_text,
        re.IGNORECASE | re.DOTALL,
    )
    if not block:
        return None
    nominal_m = re.search(r"<Nominal>(\d+)</Nominal>", block.group(0))
    value_m = re.search(r"<Value>([0-9,\.]+)</Value>", block.group(0))
    if not value_m:
        return None
    nominal = int(nominal_m.group(1)) if nominal_m else 1
    value = float(value_m.group(1).replace(",", "."))  # запятая → точка
    if value <= 0 or nominal <= 0:
        return None
    return value / nominal


def fetch_from_cbr_official(on: date | None = None) -> CbrRates | None:
    """Получить курсы из официального XML ЦБ РФ.

    :param on: дата; ``None`` — последняя доступная (сегодня).
    """
    url = CBR_OFFICIAL
    if on is not None:
        url += f"?date_req={on.day:02d}/{on.month:02d}/{on.year}"
    raw = _http_get(url)
    try:
        text = raw.decode("windows-1251")
    except UnicodeDecodeError:
        text = raw.decode("utf-8", errors="replace")

    date_m = re.search(r'Date="(\d{2})\.(\d{2})\.(\d{4})"', text)
    if not date_m:
        return None
    iso = f"{date_m.group(3)}-{date_m.group(2)}-{date_m.group(1)}"

    eur = _extract_cbr_value(text, "EUR")
    usd = _extract_cbr_value(text, "USD")
    cny = _extract_cbr_value(text, "CNY")
    if eur is None or usd is None:  # CNY может отсутствовать
        return None
    return CbrRates(date=iso, eur=eur, usd=usd, cny=cny or 0.0)


# ----------------------------------------------------------------------
# Источники 2-3: JSON-зеркала
# ----------------------------------------------------------------------
def fetch_from_cbr_mirror(
    on: date | None,
    main_url: str,
    archive_base: str | None,
) -> CbrRates | None:
    """Получить курсы из JSON-зеркала cbr-xml-daily.

    :param on: дата; ``None`` — текущая;
    :param main_url: URL для текущей даты;
    :param archive_base: база URL архива (``None`` — архива нет).
    """
    if on is None:
        url = main_url
    elif archive_base:
        url = f"{archive_base}{on.year}/{on.month:02d}/{on.day:02d}/daily_json.js"
    else:
        return None  # у этого зеркала нет архива

    data = json.loads(_http_get(url).decode("utf-8"))
    valute = data["Valute"]
    cny = valute.get("CNY", {}).get("Value", 0.0)
    return CbrRates(
        date=data["Date"].split("T")[0],
        eur=valute["EUR"]["Value"],
        usd=valute["USD"]["Value"],
        cny=cny or 0.0,
    )


# ----------------------------------------------------------------------
# Цепочка с fallback
# ----------------------------------------------------------------------
def fetch_rates_for_date(on: date | None = None) -> CbrRates | None:
    """Получить курсы с автоматическим перебором источников.

    Порядок: официальный ЦБ → cbr-xml-daily.ru → cbr-xml-daily.com.
    Возвращает ``None``, если ни один источник не ответил.

    :param on: дата; ``None`` — последняя доступная.
    """
    for fn in (
        lambda: fetch_from_cbr_official(on),
        lambda: fetch_from_cbr_mirror(on, CBR_MIRROR_RU, CBR_MIRROR_RU_ARC),
        lambda: fetch_from_cbr_mirror(on, CBR_MIRROR_COM, None),
    ):
        try:
            result = fn()
            if result:
                return result
        except Exception:  # noqa: BLE001 — пробуем следующий источник
            continue
    return None


def fetch_rates_range(start: date, end: date):
    """Генератор курсов по дням за период ``[start, end]``.

    Выдаёт пары ``(date, CbrRates | None)`` для каждого дня. Между
    запросами стоит небольшая пауза, чтобы не перегружать источник.
    """
    import time
    from datetime import timedelta

    if end < start:
        raise ValueError("Дата окончания раньше даты начала")
    cur = start
    while cur <= end:
        yield cur, fetch_rates_for_date(cur)
        cur += timedelta(days=1)
        time.sleep(0.15)


def diagnose_sources() -> list[str]:
    """Диагностика источников курсов (порт ``diagnoseRateSources``).

    Возвращает список строк-отчётов по каждому источнику.
    """
    import time

    checks = [
        ("ЦБ РФ официальный", lambda: fetch_from_cbr_official(None)),
        ("cbr-xml-daily.ru", lambda: fetch_from_cbr_mirror(
            None, CBR_MIRROR_RU, CBR_MIRROR_RU_ARC)),
        ("cbr-xml-daily.com", lambda: fetch_from_cbr_mirror(
            None, CBR_MIRROR_COM, None)),
    ]
    lines: list[str] = []
    for name, fn in checks:
        t0 = time.time()
        try:
            r = fn()
            dt = int((time.time() - t0) * 1000)
            if r:
                lines.append(
                    f"✓ {name} ({dt} мс): EUR={r.eur:.4f}, "
                    f"USD={r.usd:.4f}, дата {r.date}"
                )
            else:
                lines.append(f"✗ {name}: ответ пустой / не распарсился")
        except Exception as exc:  # noqa: BLE001
            lines.append(f"✗ {name}: {exc}")
    return lines
