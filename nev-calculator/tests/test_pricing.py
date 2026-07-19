"""Тесты ценообразования: округление, пересчёт валют, цены сырья."""

from __future__ import annotations

from nev_calc import excel_round
from nev_calc.models import Rate
from nev_calc.pricing import (
    PriceMode,
    component_price,
    currency_to_eur_factor,
    latest_rate,
    raw_price_eur,
    rate_on,
)


class TestExcelRound:
    def test_half_up(self):
        # Excel округляет половину «от нуля», а не по-банковски.
        assert excel_round(0.5, 0) == 1
        assert excel_round(2.5, 0) == 3
        assert excel_round(1.005, 2) == 1.01

    def test_typical_values(self):
        assert excel_round(2.82555, 2) == 2.83
        assert excel_round(0.0728, 2) == 0.07
        assert excel_round(0.0772, 2) == 0.08

    def test_none(self):
        assert excel_round(None) == 0.0


class TestCurrencyFactor:
    def test_eur_is_one(self):
        assert currency_to_eur_factor("EUR", None) == 1.0

    def test_rub(self):
        rate = Rate(date_serial=1.0, eur_rub=80.0, eur_usd=1.1, eur_cny=12.0)
        assert currency_to_eur_factor("RUB", rate) == 1.0 / 80.0

    def test_usd_cny(self):
        rate = Rate(date_serial=1.0, eur_rub=80.0, eur_usd=1.1, eur_cny=12.0)
        assert currency_to_eur_factor("USD", rate) == 1.0 / 1.1
        assert currency_to_eur_factor("CNY", rate) == 1.0 / 12.0

    def test_missing_rate(self):
        assert currency_to_eur_factor("RUB", None) == 0.0


class TestRateLookup:
    def test_latest(self, catalog):
        r = latest_rate(catalog)
        assert r is not None
        # последний по дате — максимальный серийный номер
        assert r.date_serial == max(x.date_serial for x in catalog.rates)

    def test_rate_on_picks_le(self, catalog):
        serials = sorted(x.date_serial for x in catalog.rates)
        mid = serials[1]
        r = rate_on(catalog, mid)
        assert r.date_serial <= mid


class TestRawPrice:
    def test_eur_material(self, catalog):
        mat = next(m for m in catalog.raw_materials if m.price_eur > 0)
        assert raw_price_eur(catalog, mat.name) == mat.price_eur

    def test_unknown(self, catalog):
        assert raw_price_eur(catalog, "НЕСУЩЕСТВУЮЩЕЕ СЫРЬЁ") == 0.0


class TestComponentPrice:
    def test_semi_stored_vs_live(self, catalog):
        semi = catalog.semi_products[0].name
        stored = component_price(catalog, semi, PriceMode.STORED)
        live = component_price(catalog, semi, PriceMode.LIVE)
        assert stored >= 0 and live >= 0
