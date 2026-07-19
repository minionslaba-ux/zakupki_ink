"""Модели данных калькулятора себестоимости NEV.

Каждый dataclass соответствует строке одного из листов исходной таблицы
``Калькулятор_NEV``:

* :class:`RawMaterial`  — лист «Сырьё»;
* :class:`SemiProduct`  — лист «Полупродукты»;
* :class:`Product`      — лист «Продукты»;
* :class:`RecipeLine`   — лист «Рецептуры» (одна компонента рецептуры);
* :class:`Rate`         — лист «Курсы ЦБ» (курсы на одну дату);
* :class:`LossRecord`   — лист «Потери» (статистика по реальным выпускам).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

# В Excel/Google Sheets дата хранится как число дней с 1899-12-30.
_EXCEL_EPOCH = date(1899, 12, 30)


def excel_serial_to_date(serial: float | int | None) -> date | None:
    """Преобразовать серийный номер даты Excel в :class:`datetime.date`.

    Возвращает ``None``, если на входе ``None``.
    """
    if serial is None:
        return None
    return _EXCEL_EPOCH + timedelta(days=int(serial))


def date_to_excel_serial(d: date) -> int:
    """Преобразовать :class:`datetime.date` в серийный номер Excel."""
    return (d - _EXCEL_EPOCH).days


@dataclass(slots=True)
class RawMaterial:
    """Позиция каталога сырья (лист «Сырьё»).

    :param name: наименование сырья (ключ для поиска в рецептурах);
    :param price_eur: цена в евро за кг без НДС (пересчитанная из ``currency``);
    :param currency: исходная валюта закупки (EUR/RUB/USD/CNY);
    :param price_ccy: цена в исходной валюте за кг без НДС;
    :param date_serial: дата поступления (серийный номер Excel) — определяет,
        какой курс ЦБ использовать при пересчёте в евро;
    :param unit: единица измерения;
    :param supplier: поставщик;
    :param article: артикул.
    """

    name: str
    price_eur: float = 0.0
    currency: str = "EUR"
    price_ccy: float | None = None
    date_serial: float | None = None
    unit: str | None = None
    supplier: str | None = None
    article: str | None = None

    @property
    def date(self) -> date | None:
        """Дата поступления как :class:`datetime.date`."""
        return excel_serial_to_date(self.date_serial)


@dataclass(slots=True)
class SemiProduct:
    """Позиция каталога полупродуктов (лист «Полупродукты»).

    ``price_eur`` — закэшированная в таблице цена €/кг без НДС. Она может
    быть пересчитана «вживую» из рецептуры через
    :func:`nev_calc.pricing.recompute_semi_prices`.

    :param name: наименование полупродукта;
    :param price_eur: цена €/кг без НДС (из таблицы);
    :param n_comp: число компонентов в рецептуре;
    :param article: артикул.
    """

    name: str
    price_eur: float = 0.0
    n_comp: int | None = None
    article: str | None = None


@dataclass(slots=True)
class Product:
    """Позиция каталога готовой продукции (лист «Продукты»).

    :param name: наименование продукта (ключ рецептуры);
    :param client: клиент;
    :param type: тип («ГП» — готовый продукт и т.п.);
    :param article: артикул.
    """

    name: str
    client: str | None = None
    type: str | None = None
    article: str | None = None


@dataclass(slots=True)
class RecipeLine:
    """Одна компонента рецептуры (лист «Рецептуры»).

    Рецептуры заданы как для готовых продуктов, так и для полупродуктов;
    владелец рецептуры (``owner``) — это имя продукта/полупродукта.

    :param owner: имя продукта или полупродукта, которому принадлежит строка;
    :param index: порядковый номер компоненты в рецептуре (1..N);
    :param component: имя компоненты (сырьё или полупродукт);
    :param pct_base: базовая массовая доля (0..1);
    :param pct_real: фактическая массовая доля (0..1);
    :param article: артикул продукта-владельца.
    """

    owner: str
    index: int
    component: str
    pct_base: float = 0.0
    pct_real: float | None = None
    article: str | None = None

    @property
    def key(self) -> str:
        """Ключ строки в формате ``"<owner>|<index>"`` (как в таблице)."""
        return f"{self.owner}|{self.index}"


@dataclass(slots=True)
class Rate:
    """Курсы ЦБ РФ на одну дату (лист «Курсы ЦБ»).

    :param date_serial: дата курса (серийный номер Excel);
    :param eur_rub: курс EUR/RUB;
    :param usd_rub: курс USD/RUB;
    :param cny_rub: курс CNY/RUB;
    :param eur_usd: кросс-курс EUR/USD;
    :param eur_cny: кросс-курс EUR/CNY;
    :param source: источник данных.
    """

    date_serial: float
    eur_rub: float = 0.0
    usd_rub: float = 0.0
    cny_rub: float = 0.0
    eur_usd: float = 0.0
    eur_cny: float = 0.0
    source: str | None = None

    @property
    def date(self) -> date | None:
        """Дата курса как :class:`datetime.date`."""
        return excel_serial_to_date(self.date_serial)


@dataclass(slots=True)
class LossRecord:
    """Статистика потерь по реальным выпускам (лист «Потери»).

    :param product: продукт;
    :param component: компонента;
    :param index: номер компоненты;
    :param use_per_kg: расход на 1 кг ГП;
    :param sum_comp: сумма компонентов;
    :param loss_kg: рекомендуемые потери, кг;
    :param batches: число партий в статистике;
    :param article: артикул;
    :param key: ключ ``"<product>|<component>"``.
    """

    product: str
    component: str
    index: int | None = None
    use_per_kg: float | None = None
    sum_comp: float | None = None
    loss_kg: float | None = None
    batches: int | None = None
    article: str | None = None
    key: str | None = None
