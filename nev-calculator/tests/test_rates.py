"""Тесты загрузки курсов ЦБ — без обращения к сети (через монипатч)."""

from __future__ import annotations

import json

import pytest

from nev_calc import rates as rates_mod
from nev_calc.rates import (
    CbrRates,
    _extract_cbr_value,
    fetch_from_cbr_mirror,
    fetch_rates_for_date,
)

# Фрагмент официального XML ЦБ РФ (windows-1251 в проде, здесь — str).
SAMPLE_XML = (
    '<?xml version="1.0" encoding="windows-1251"?>'
    '<ValCurs Date="01.06.2026" name="Foreign Currency Market">'
    '<Valute ID="R01239"><NumCode>978</NumCode><CharCode>EUR</CharCode>'
    '<Nominal>1</Nominal><Name>Евро</Name><Value>92,5000</Value></Valute>'
    '<Valute ID="R01235"><NumCode>840</NumCode><CharCode>USD</CharCode>'
    '<Nominal>1</Nominal><Name>Доллар</Name><Value>80,1234</Value></Valute>'
    '<Valute ID="R01375"><NumCode>156</NumCode><CharCode>CNY</CharCode>'
    '<Nominal>10</Nominal><Name>Юань</Name><Value>110,0000</Value></Valute>'
    "</ValCurs>"
)

SAMPLE_JSON = json.dumps(
    {
        "Date": "2026-06-01T11:30:00+03:00",
        "Valute": {
            "EUR": {"Value": 92.5},
            "USD": {"Value": 80.1234},
            "CNY": {"Value": 11.0},
        },
    }
).encode("utf-8")


class TestExtractValue:
    def test_nominal_one(self):
        assert _extract_cbr_value(SAMPLE_XML, "EUR") == 92.5

    def test_comma_decimal(self):
        assert _extract_cbr_value(SAMPLE_XML, "USD") == 80.1234

    def test_nominal_ten(self):
        # 110.0000 / 10 = 11.0
        assert _extract_cbr_value(SAMPLE_XML, "CNY") == 11.0

    def test_missing_currency(self):
        assert _extract_cbr_value(SAMPLE_XML, "GBP") is None


class TestCbrRatesCross:
    def test_cross_rates(self):
        r = CbrRates(date="2026-06-01", eur=92.5, usd=80.0, cny=11.0)
        assert r.eur_usd == pytest.approx(92.5 / 80.0)
        assert r.eur_cny == pytest.approx(92.5 / 11.0)

    def test_zero_safe(self):
        r = CbrRates(date="2026-06-01", eur=92.5, usd=0.0, cny=0.0)
        assert r.eur_usd == 0.0
        assert r.eur_cny == 0.0


class TestMirror:
    def test_parse_json(self, monkeypatch):
        monkeypatch.setattr(rates_mod, "_http_get", lambda url: SAMPLE_JSON)
        r = fetch_from_cbr_mirror(None, rates_mod.CBR_MIRROR_RU, None)
        assert r.eur == 92.5
        assert r.usd == 80.1234
        assert r.cny == 11.0
        assert r.date == "2026-06-01"


class TestFallbackChain:
    def test_uses_second_source_when_first_fails(self, monkeypatch):
        def boom(*_a, **_k):
            raise RuntimeError("официальный недоступен")

        monkeypatch.setattr(rates_mod, "fetch_from_cbr_official", boom)
        monkeypatch.setattr(
            rates_mod,
            "fetch_from_cbr_mirror",
            lambda on, url, arc: CbrRates(date="2026-06-01", eur=92.5, usd=80.0),
        )
        r = fetch_rates_for_date(None)
        assert r is not None
        assert r.eur == 92.5

    def test_returns_none_when_all_fail(self, monkeypatch):
        monkeypatch.setattr(
            rates_mod, "fetch_from_cbr_official",
            lambda on: (_ for _ in ()).throw(RuntimeError()),
        )
        monkeypatch.setattr(
            rates_mod, "fetch_from_cbr_mirror", lambda on, url, arc: None
        )
        assert fetch_rates_for_date(None) is None
