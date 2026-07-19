"""Командный интерфейс калькулятора NEV.

Запуск::

    python -m nev_calc <команда> [параметры]

Команды:

* ``cost``      — себестоимость продукта с построчной разбивкой;
* ``products``  — список продуктов (с фильтром);
* ``material``  — цена позиции сырья;
* ``semi``      — цена полупродукта и его рецептура;
* ``rates``     — показать/обновить курсы ЦБ РФ;
* ``diagnose``  — проверить доступность источников курсов.

По умолчанию данные берутся из встроенного снимка. Чтобы считать из «живой»
книги Excel, добавьте ``--xlsx путь/к/Калькулятор_NEV.xlsx`` (нужен openpyxl).
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, datetime

from .calculator import Calculator
from .catalog import Catalog
from .pricing import PriceMode, raw_price_eur


def _load_catalog(args) -> Catalog:
    """Загрузить каталог из xlsx (если задан) или из встроенного JSON."""
    if getattr(args, "xlsx", None):
        return Catalog.from_xlsx(args.xlsx)
    return Catalog.from_json(getattr(args, "json", None))


def _mode(args) -> PriceMode:
    """Режим цен полупродуктов по флагу ``--live``."""
    return PriceMode.LIVE if getattr(args, "live", False) else PriceMode.STORED


def _fmt(x: float) -> str:
    """Форматирование числа с двумя знаками."""
    return f"{x:,.2f}".replace(",", " ")


# ----------------------------------------------------------------------
# Команды
# ----------------------------------------------------------------------
def cmd_cost(args) -> int:
    """Рассчитать себестоимость продукта."""
    cat = _load_catalog(args)
    calc = Calculator(cat, mode=_mode(args))

    product = args.product
    if args.article:
        found = calc.find_by_article(args.article)
        if not found:
            print(f"Артикул «{args.article}» не найден", file=sys.stderr)
            return 1
        product = found

    try:
        res = calc.compute(
            product,
            loss_pct=args.loss,
            eur_rate=args.rate,
        )
    except KeyError as exc:
        print(exc, file=sys.stderr)
        return 1

    if getattr(args, "json_out", False):
        print(json.dumps(res.as_dict(), ensure_ascii=False, indent=2))
        return 0

    print(f"Продукт:  {res.product}")
    if res.article:
        print(f"Артикул:  {res.article}")
    print(f"Курс EUR/RUB: {_fmt(res.eur_rate)}   Потери: {res.loss_pct * 100:.1f}%"
          f"   Σ%: {res.sum_pct * 100:.2f}%")
    print("-" * 72)
    print(f"{'№':>2}  {'Компонента':42} {'%':>7} {'€/кг':>8} {'₽/кг':>10}")
    print("-" * 72)
    for ln in res.lines:
        if not ln.component:
            continue
        mark = "⚗" if ln.kind == "semi" else " "
        name = (ln.component[:40] + "…") if len(ln.component) > 41 else ln.component
        print(f"{ln.index:>2}{mark} {name:41} {ln.pct * 100:>6.2f} "
              f"{_fmt(ln.eur_no_vat):>8} {_fmt(ln.rub_no_vat):>10}")
    print("-" * 72)
    print(f"ИТОГО себестоимость 1 кг ГП:")
    print(f"  €/кг без НДС: {_fmt(res.eur_no_vat):>10}    "
          f"€/кг с НДС: {_fmt(res.eur_vat):>10}")
    print(f"  ₽/кг без НДС: {_fmt(res.rub_no_vat):>10}    "
          f"₽/кг с НДС: {_fmt(res.rub_vat):>10}")
    return 0


def cmd_products(args) -> int:
    """Вывести список продуктов."""
    cat = _load_catalog(args)
    flt = (args.filter or "").lower()
    rows = [
        p for p in cat.products
        if not flt or flt in p.name.lower() or (p.client or "").lower().find(flt) >= 0
    ]
    print(f"Найдено продуктов: {len(rows)}")
    for p in rows:
        art = f"  [{p.article}]" if p.article else ""
        client = f"  ({p.client})" if p.client else ""
        print(f"  {p.name}{client}{art}")
    return 0


def cmd_material(args) -> int:
    """Показать цену позиции сырья."""
    cat = _load_catalog(args)
    mat = cat.raw(args.name)
    if not mat:
        print(f"Сырьё «{args.name}» не найдено", file=sys.stderr)
        return 1
    print(f"{mat.name}")
    print(f"  Валюта: {mat.currency}   Цена в валюте: {mat.price_ccy}")
    print(f"  Цена €/кг без НДС: {_fmt(raw_price_eur(cat, mat.name))}")
    return 0


def cmd_semi(args) -> int:
    """Показать цену полупродукта и его рецептуру."""
    cat = _load_catalog(args)
    calc = Calculator(cat, mode=_mode(args))
    semi = cat.semi(args.name)
    if not semi:
        print(f"Полупродукт «{args.name}» не найден", file=sys.stderr)
        return 1
    try:
        res = calc.compute(args.name, eur_rate=args.rate)
        total = res.eur_no_vat
    except KeyError:
        total = semi.price_eur
        res = None
    print(f"{semi.name}")
    print(f"  Цена €/кг без НДС (в таблице): {_fmt(semi.price_eur)}")
    print(f"  Цена €/кг ({'live' if args.live else 'stored'}): {_fmt(total)}")
    if res:
        for ln in res.lines:
            mark = "⚗" if ln.kind == "semi" else " "
            print(f"    {ln.index:>2}{mark} {ln.pct * 100:>6.2f}%  "
                  f"{ln.component[:45]}  →  {_fmt(ln.eur_no_vat)} €")
    return 0


def cmd_rates(args) -> int:
    """Показать сохранённые или обновить курсы ЦБ."""
    if args.update:
        from .rates import fetch_rates_for_date

        on = _parse_date(args.date) if args.date else None
        r = fetch_rates_for_date(on)
        if not r:
            print("Не удалось получить курсы ни из одного источника",
                  file=sys.stderr)
            return 1
        print(f"Дата: {r.date}")
        print(f"  EUR/RUB: {r.eur:.4f}")
        print(f"  USD/RUB: {r.usd:.4f}")
        print(f"  CNY/RUB: {r.cny:.4f}" if r.cny else "  CNY/RUB: нет")
        return 0

    cat = _load_catalog(args)
    print(f"Курсов в каталоге: {len(cat.rates)}")
    for rt in sorted(cat.rates, key=lambda x: x.date_serial):
        d = rt.date.isoformat() if rt.date else "?"
        print(f"  {d}   EUR/RUB={rt.eur_rub:.4f}   USD/RUB={rt.usd_rub:.4f}   "
              f"CNY/RUB={rt.cny_rub:.4f}   [{rt.source or ''}]")
    return 0


def cmd_diagnose(args) -> int:
    """Проверить доступность источников курсов."""
    from .rates import diagnose_sources

    for line in diagnose_sources():
        print(line)
    return 0


def _parse_date(s: str) -> date:
    """Разобрать дату в форматах ДД.ММ.ГГГГ или ГГГГ-ММ-ДД."""
    for fmt in ("%d.%m.%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise argparse.ArgumentTypeError(f"Неверная дата: {s}")


# ----------------------------------------------------------------------
# Разбор аргументов
# ----------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    """Собрать парсер аргументов CLI."""
    p = argparse.ArgumentParser(
        prog="nev_calc",
        description="Калькулятор себестоимости NEV (порт таблицы Калькулятор_NEV)",
    )

    def add_common(sp):
        sp.add_argument("--xlsx", help="путь к книге Калькулятор_NEV.xlsx")
        sp.add_argument("--json", help="путь к JSON-снимку данных")

    sub = p.add_subparsers(dest="command", required=True)

    sc = sub.add_parser("cost", help="себестоимость продукта")
    add_common(sc)
    sc.add_argument("product", nargs="?", default=None, help="имя продукта")
    sc.add_argument("--article", help="искать продукт по артикулу")
    sc.add_argument("--loss", type=float, default=0.0,
                    help="глобальные потери, доля (0.05 = 5%%)")
    sc.add_argument("--rate", type=float, default=None,
                    help="курс EUR/RUB (по умолчанию — последний из каталога)")
    sc.add_argument("--live", action="store_true",
                    help="пересчитать цены полупродуктов из рецептур")
    sc.add_argument("--as-json", dest="json_out", action="store_true",
                    help="вывести результат в JSON")
    sc.set_defaults(func=cmd_cost)

    sp = sub.add_parser("products", help="список продуктов")
    add_common(sp)
    sp.add_argument("--filter", help="фильтр по имени/клиенту")
    sp.set_defaults(func=cmd_products)

    sm = sub.add_parser("material", help="цена сырья")
    add_common(sm)
    sm.add_argument("name", help="имя сырья")
    sm.set_defaults(func=cmd_material)

    ss = sub.add_parser("semi", help="цена и рецептура полупродукта")
    add_common(ss)
    ss.add_argument("name", help="имя полупродукта")
    ss.add_argument("--rate", type=float, default=None, help="курс EUR/RUB")
    ss.add_argument("--live", action="store_true",
                    help="пересчитать цены из рецептур")
    ss.set_defaults(func=cmd_semi)

    sr = sub.add_parser("rates", help="курсы ЦБ РФ")
    add_common(sr)
    sr.add_argument("--update", action="store_true",
                    help="загрузить актуальный курс из ЦБ РФ")
    sr.add_argument("--date", help="дата для --update (ДД.ММ.ГГГГ)")
    sr.set_defaults(func=cmd_rates)

    sd = sub.add_parser("diagnose", help="проверить источники курсов")
    sd.set_defaults(func=cmd_diagnose)

    return p


def main(argv: list[str] | None = None) -> int:
    """Точка входа CLI."""
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command == "cost" and not args.product and not args.article:
        parser.error("укажите имя продукта или --article")
    return args.func(args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
