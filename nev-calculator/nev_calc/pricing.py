"""Ценообразование: пересчёт валют, цены компонент и свёртка себестоимости.

Воспроизводит формулы листов «Сырьё», «Полупродукты» и «Калькулятор».

Два режима расчёта цены компоненты (см. :class:`PriceMode`):

* ``STORED``  — использовать закэшированную в таблице цену полупродукта
  (как делает лист «Калькулятор» через ``VLOOKUP`` по «Полупродукты»).
  Точно воспроизводит числа из файла.
* ``LIVE``    — пересчитать цену каждого полупродукта рекурсивно из его
  рецептуры и текущих цен сырья. Самосогласованно и реагирует на
  изменение цен/курсов.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from enum import Enum

from .catalog import Catalog
from .models import Rate


class PriceMode(str, Enum):
    """Режим определения цены полупродукта."""

    STORED = "stored"  # цена из таблицы (точное воспроизведение)
    LIVE = "live"  # рекурсивный пересчёт из рецептуры


def excel_round(value: float, digits: int = 2) -> float:
    """Округление «как в Excel» — половина от нуля (ROUND_HALF_UP).

    Встроенный :func:`round` в Python использует банковское округление,
    что иногда расходится с Excel в последнем знаке.
    """
    if value is None:
        return 0.0
    quant = Decimal(1).scaleb(-digits)  # 10**-digits
    return float(Decimal(str(value)).quantize(quant, rounding=ROUND_HALF_UP))


# ----------------------------------------------------------------------
# Курсы и пересчёт валют
# ----------------------------------------------------------------------
def latest_rate(catalog: Catalog) -> Rate | None:
    """Последний по дате курс из листа «Курсы ЦБ» (как ячейка J8)."""
    if not catalog.rates:
        return None
    return max(catalog.rates, key=lambda r: r.date_serial)


def rate_on(catalog: Catalog, date_serial: float | None) -> Rate | None:
    """Курс на дату ``date_serial`` (последний с датой ≤ заданной).

    Воспроизводит ``LOOKUP`` по отсортированному столбцу дат. Если дата не
    указана — берётся последний доступный курс.
    """
    rates = sorted(catalog.rates, key=lambda r: r.date_serial)
    if not rates:
        return None
    if date_serial is None:
        return rates[-1]
    chosen = None
    for r in rates:
        if r.date_serial <= date_serial:
            chosen = r
        else:
            break
    return chosen or rates[0]


def currency_to_eur_factor(
    currency: str, rate: Rate | None
) -> float:
    """Коэффициент пересчёта «1 единица валюты = X €».

    Воспроизводит столбец L листа «Сырьё»::

        EUR -> 1
        RUB -> 1 / (EUR/RUB)
        USD -> 1 / (EUR/USD)
        CNY -> 1 / (EUR/CNY)

    При недоступном курсе возвращает ``0`` (как ``IFERROR(...,0)``).
    """
    cur = (currency or "EUR").upper()
    if cur == "EUR":
        return 1.0
    if rate is None:
        return 0.0
    pair = {"RUB": rate.eur_rub, "USD": rate.eur_usd, "CNY": rate.eur_cny}.get(cur)
    if not pair:
        return 0.0
    return 1.0 / pair


def raw_price_eur(catalog: Catalog, material_name: str) -> float:
    """Цена сырья в €/кг без НДС.

    Если у позиции задана исходная валюта и цена в валюте — пересчитывает
    через курс ЦБ на дату поступления (столбцы J/K/L листа «Сырьё»).
    Иначе берёт уже посчитанную цену ``price_eur``.
    """
    mat = catalog.raw(material_name)
    if mat is None:
        return 0.0
    if mat.price_ccy is not None and (mat.currency or "EUR").upper() != "EUR":
        factor = currency_to_eur_factor(
            mat.currency, rate_on(catalog, mat.date_serial)
        )
        return mat.price_ccy * factor
    return mat.price_eur or 0.0


# ----------------------------------------------------------------------
# Цена компоненты и рекурсивная свёртка полупродуктов
# ----------------------------------------------------------------------
def recompute_semi_prices(catalog: Catalog) -> dict[str, float]:
    """Пересчитать цены всех полупродуктов рекурсивно из рецептур.

    Возвращает словарь ``{имя_полупродукта: цена €/кг}``. Циклы в рецептурах
    разрываются (компонента в цикле учитывается как 0). Результат можно
    применить к каталогу, см. :func:`apply_live_prices`.
    """
    memo: dict[str, float] = {}

    def cost(name: str, stack: frozenset[str]) -> float:
        cached = memo.get(name)
        if cached is not None:
            return cached
        if name in stack:  # защита от цикла
            return 0.0
        inner = stack | {name}
        total = 0.0
        for line in catalog.recipe_lines(name):
            total += (line.pct_base or 0.0) * _component_price_live(
                catalog, line.component, inner, cost
            )
        result = excel_round(total, 4)
        memo[name] = result
        return result

    return {s.name: cost(s.name, frozenset()) for s in catalog.semi_products}


def _component_price_live(catalog, component, stack, cost_fn) -> float:
    """Цена компоненты в режиме LIVE (полупродукт считается рекурсивно)."""
    if catalog.is_semi(component):
        return cost_fn(component, stack)
    return raw_price_eur(catalog, component)


def apply_live_prices(catalog: Catalog) -> Catalog:
    """Записать пересчитанные «живые» цены в полупродукты каталога."""
    prices = recompute_semi_prices(catalog)
    for s in catalog.semi_products:
        if s.name in prices:
            s.price_eur = prices[s.name]
    return catalog.reindex()


def component_price(
    catalog: Catalog,
    component: str,
    mode: PriceMode = PriceMode.STORED,
) -> float:
    """Базовая цена компоненты €/кг без НДС (без учёта доли и потерь).

    * полупродукт: цена из таблицы (STORED) или рекурсивный пересчёт (LIVE);
    * сырьё: :func:`raw_price_eur`;
    * не найдено: ``0`` (как ``IFERROR(...,0)`` в таблице).
    """
    if catalog.is_semi(component):
        if mode is PriceMode.LIVE:
            return recompute_semi_prices(catalog).get(component, 0.0)
        semi = catalog.semi(component)
        return semi.price_eur if semi else 0.0
    return raw_price_eur(catalog, component)
