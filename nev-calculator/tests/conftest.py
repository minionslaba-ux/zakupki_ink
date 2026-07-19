"""Общие фикстуры pytest."""

from __future__ import annotations

import pytest

from nev_calc import Catalog


@pytest.fixture(scope="session")
def catalog() -> Catalog:
    """Каталог из встроенного снимка данных (один раз на сессию)."""
    return Catalog.from_json()
