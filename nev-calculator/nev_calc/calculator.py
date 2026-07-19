"""Высокоуровневый калькулятор себестоимости — воспроизведение листа «Калькулятор».

Класс :class:`Calculator` собирает развёрнутую рецептуру продукта, считает
себестоимость €/кг и ₽/кг с НДС и без НДС, учитывает глобальные потери и
ручные переопределения долей/цен.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .catalog import Catalog
from .pricing import (
    PriceMode,
    excel_round,
    latest_rate,
    raw_price_eur,
    recompute_semi_prices,
)


@dataclass(slots=True)
class CostLine:
    """Строка развёрнутой рецептуры в результате расчёта.

    :param index: номер компоненты;
    :param component: имя компоненты;
    :param kind: ``"semi"`` (полупродукт) или ``"raw"`` (сырьё);
    :param pct: применённая массовая доля (0..1);
    :param qty_per_kg: количество на 1 кг с учётом потерь;
    :param base_price_eur: цена компоненты €/кг без НДС;
    :param eur_no_vat: стоимость компоненты €/кг без НДС;
    :param rub_no_vat: стоимость компоненты ₽/кг без НДС.
    """

    index: int
    component: str
    kind: str
    pct: float
    qty_per_kg: float
    base_price_eur: float
    eur_no_vat: float
    rub_no_vat: float


@dataclass(slots=True)
class CostResult:
    """Итог расчёта себестоимости продукта.

    Поля ``*_eur`` — за 1 кг готового продукта в евро, ``*_rub`` — в рублях;
    ``*_vat`` — с НДС, ``*_no_vat`` — без НДС.
    """

    product: str
    article: str | None
    eur_rate: float
    vat_rate: float
    loss_pct: float
    sum_pct: float
    lines: list[CostLine] = field(default_factory=list)

    eur_no_vat: float = 0.0
    eur_vat: float = 0.0
    rub_no_vat: float = 0.0
    rub_vat: float = 0.0

    def as_dict(self) -> dict:
        """Представление результата как словаря (для JSON/печати)."""
        return {
            "product": self.product,
            "article": self.article,
            "eur_rate": self.eur_rate,
            "vat_rate": self.vat_rate,
            "loss_pct": self.loss_pct,
            "sum_pct": self.sum_pct,
            "eur_no_vat": self.eur_no_vat,
            "eur_vat": self.eur_vat,
            "rub_no_vat": self.rub_no_vat,
            "rub_vat": self.rub_vat,
            "lines": [
                {
                    "index": ln.index,
                    "component": ln.component,
                    "kind": ln.kind,
                    "pct": ln.pct,
                    "qty_per_kg": ln.qty_per_kg,
                    "base_price_eur": ln.base_price_eur,
                    "eur_no_vat": ln.eur_no_vat,
                    "rub_no_vat": ln.rub_no_vat,
                }
                for ln in self.lines
            ],
        }


class Calculator:
    """Калькулятор себестоимости поверх :class:`Catalog`.

    :param catalog: загруженный каталог;
    :param mode: режим цен полупродуктов (STORED — как в файле, LIVE — пересчёт).
    """

    def __init__(
        self, catalog: Catalog, mode: PriceMode = PriceMode.STORED
    ) -> None:
        self.catalog = catalog
        self.mode = mode
        # В режиме LIVE один раз считаем цены всех полупродуктов.
        self._live_prices: dict[str, float] = (
            recompute_semi_prices(catalog) if mode is PriceMode.LIVE else {}
        )

    # ------------------------------------------------------------------
    def default_rate(self) -> float:
        """Курс EUR/RUB по умолчанию — последний из «Курсы ЦБ» (ячейка J8)."""
        rate = latest_rate(self.catalog)
        return rate.eur_rub if rate else 0.0

    def _semi_price(self, name: str) -> float:
        """Цена полупродукта согласно режиму калькулятора."""
        if self.mode is PriceMode.LIVE:
            return self._live_prices.get(name, 0.0)
        semi = self.catalog.semi(name)
        return semi.price_eur if semi else 0.0

    def _base_price(self, component: str) -> float:
        """Базовая цена компоненты €/кг (полупродукт или сырьё)."""
        if self.catalog.is_semi(component):
            return self._semi_price(component)
        return raw_price_eur(self.catalog, component)

    # ------------------------------------------------------------------
    def find_by_article(self, article: str) -> str | None:
        """Поиск имени продукта/полупродукта по артикулу (ячейка G8→H8)."""
        return self.catalog.name_by_article(article)

    def compute(
        self,
        product: str,
        *,
        loss_pct: float = 0.0,
        eur_rate: float | None = None,
        manual_pct: dict[int, float] | None = None,
        manual_price_eur: dict[int, float] | None = None,
    ) -> CostResult:
        """Рассчитать себестоимость продукта (или полупродукта).

        :param product: имя продукта/полупродукта (как в каталоге);
        :param loss_pct: глобальные потери (доля, напр. ``0.05`` = 5 %),
            ячейка ``M11``;
        :param eur_rate: курс EUR/RUB; по умолчанию — :meth:`default_rate`;
        :param manual_pct: переопределение доли по номеру компоненты (G17:G36);
        :param manual_price_eur: переопределение цены €/кг по номеру
            компоненты (M17:M36) — применяется, если значение ``> 0``.
        :returns: :class:`CostResult` с построчной разбивкой и итогами.
        :raises KeyError: если рецептура продукта не найдена.
        """
        lines = self.catalog.recipe_lines(product)
        if not lines:
            raise KeyError(f"Рецептура для «{product}» не найдена")

        rate = eur_rate if eur_rate is not None else self.default_rate()
        manual_pct = manual_pct or {}
        manual_price_eur = manual_price_eur or {}
        vat = self.catalog.vat_rate

        cost_lines: list[CostLine] = []
        sum_pct = 0.0
        sum_eur = 0.0

        for line in lines:
            if not line.component:
                continue
            pct = manual_pct.get(line.index, line.pct_base or 0.0)
            qty = excel_round(pct * (1.0 + loss_pct), 6)

            override = manual_price_eur.get(line.index)
            if override is not None and override > 0:
                price = override
            else:
                price = self._base_price(line.component)

            eur = excel_round(qty * price, 2)
            rub = excel_round(eur * rate, 2)

            sum_pct += pct
            sum_eur += eur
            cost_lines.append(
                CostLine(
                    index=line.index,
                    component=line.component,
                    kind="semi" if self.catalog.is_semi(line.component) else "raw",
                    pct=pct,
                    qty_per_kg=qty,
                    base_price_eur=price,
                    eur_no_vat=eur,
                    rub_no_vat=rub,
                )
            )

        total_eur = excel_round(sum_eur, 2)
        article = None
        prod = self.catalog.product(product) or self.catalog.semi(product)
        if prod is not None:
            article = prod.article

        return CostResult(
            product=product,
            article=article,
            eur_rate=rate,
            vat_rate=vat,
            loss_pct=loss_pct,
            sum_pct=excel_round(sum_pct, 6),
            lines=cost_lines,
            eur_no_vat=total_eur,
            eur_vat=excel_round(total_eur * (1 + vat), 2),
            rub_no_vat=excel_round(total_eur * rate, 2),
            rub_vat=excel_round(total_eur * (1 + vat) * rate, 2),
        )
