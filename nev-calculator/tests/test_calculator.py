"""Тесты калькулятора себестоимости — сверка с числами из таблицы."""

from __future__ import annotations

import pytest

from nev_calc import Calculator, Catalog, PriceMode

# Эталон из листа «Калькулятор» исходной книги для продукта ниже:
#   B11 €/кг без НДС = 3.12, E11 €/кг с НДС = 3.81
#   G11 ₽/кг без НДС = 261.11, J11 ₽/кг с НДС = 318.55 (курс 83.6892)
REF_PRODUCT = "Black (PBl 7) / RASTR"
REF_RATE = 83.6892


class TestReferenceProduct:
    def test_eur_no_vat_matches_sheet(self, catalog):
        calc = Calculator(catalog)  # режим STORED — как в файле
        res = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        assert res.eur_no_vat == 3.12

    def test_vat_and_rub(self, catalog):
        calc = Calculator(catalog)
        res = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        assert res.eur_vat == 3.81
        assert res.rub_no_vat == 261.11
        assert res.rub_vat == 318.55

    def test_percentages_sum_to_one(self, catalog):
        calc = Calculator(catalog)
        res = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        assert abs(res.sum_pct - 1.0) < 1e-9

    def test_lines_present(self, catalog):
        calc = Calculator(catalog)
        res = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        non_empty = [ln for ln in res.lines if ln.component]
        assert len(non_empty) >= 3
        # есть и сырьё, и полупродукт
        kinds = {ln.kind for ln in non_empty}
        assert "raw" in kinds


class TestLosses:
    def test_losses_increase_cost(self, catalog):
        calc = Calculator(catalog)
        base = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        with_loss = calc.compute(REF_PRODUCT, eur_rate=REF_RATE, loss_pct=0.10)
        assert with_loss.eur_no_vat > base.eur_no_vat


class TestManualOverrides:
    def test_manual_price_override(self, catalog):
        calc = Calculator(catalog)
        res = calc.compute(
            REF_PRODUCT, eur_rate=REF_RATE, manual_price_eur={1: 100.0}
        )
        # переопределённая дорогая цена первой компоненты поднимает итог
        base = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        assert res.eur_no_vat > base.eur_no_vat

    def test_manual_pct_override(self, catalog):
        calc = Calculator(catalog)
        res = calc.compute(REF_PRODUCT, eur_rate=REF_RATE, manual_pct={1: 0.0})
        base = calc.compute(REF_PRODUCT, eur_rate=REF_RATE)
        assert res.eur_no_vat < base.eur_no_vat


class TestLiveMode:
    def test_live_runs_for_all_products(self, catalog):
        calc = Calculator(catalog, mode=PriceMode.LIVE)
        computed = 0
        for p in catalog.products:
            if not catalog.recipe_lines(p.name):
                continue
            res = calc.compute(p.name, eur_rate=REF_RATE)
            assert res.eur_no_vat >= 0
            computed += 1
        assert computed > 100


class TestErrors:
    def test_unknown_product_raises(self, catalog):
        calc = Calculator(catalog)
        with pytest.raises(KeyError):
            calc.compute("НЕТ ТАКОГО ПРОДУКТА")


class TestAllProductsStored:
    def test_every_product_computes(self, catalog):
        calc = Calculator(catalog)
        bad = []
        for p in catalog.products:
            if not catalog.recipe_lines(p.name):
                continue
            try:
                calc.compute(p.name, eur_rate=REF_RATE)
            except Exception as exc:  # noqa: BLE001
                bad.append((p.name, str(exc)))
        assert not bad, bad[:5]


def test_default_rate_is_latest(catalog):
    calc = Calculator(catalog)
    assert calc.default_rate() == max(r.eur_rub for r in catalog.rates)


def test_from_json_explicit_path():
    # явный путь к встроенному снимку
    from nev_calc.catalog import DEFAULT_DATA_PATH

    cat = Catalog.from_json(DEFAULT_DATA_PATH)
    assert len(cat.products) > 100
    assert len(cat.recipes) > 500
