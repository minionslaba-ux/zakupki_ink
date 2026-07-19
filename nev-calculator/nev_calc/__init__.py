"""nev_calc — калькулятор себестоимости NEV.

Порт логики таблицы ``Калькулятор_NEV`` и её Apps Script на Python:

* :class:`~nev_calc.catalog.Catalog`       — справочники (сырьё, полупродукты,
  продукты, рецептуры, курсы, потери);
* :class:`~nev_calc.calculator.Calculator` — расчёт себестоимости €/кг и ₽/кг;
* модуль :mod:`nev_calc.rates`             — загрузка курсов ЦБ РФ.

Быстрый старт::

    from nev_calc import Catalog, Calculator

    cat = Catalog.from_json()                 # встроенный снимок данных
    calc = Calculator(cat)
    res = calc.compute("Black (PBl 7) / RASTR")
    print(res.eur_no_vat, res.rub_vat)
"""

from __future__ import annotations

from .calculator import Calculator, CostLine, CostResult
from .catalog import Catalog
from .models import (
    LossRecord,
    Product,
    RawMaterial,
    Rate,
    RecipeLine,
    SemiProduct,
)
from .pricing import PriceMode, excel_round

__all__ = [
    "Catalog",
    "Calculator",
    "CostLine",
    "CostResult",
    "PriceMode",
    "excel_round",
    "RawMaterial",
    "SemiProduct",
    "Product",
    "RecipeLine",
    "Rate",
    "LossRecord",
]

__version__ = "1.0.0"
