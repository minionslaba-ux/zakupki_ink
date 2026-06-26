# NEV Calculator

Калькулятор себестоимости готовой продукции **NEV** на Python.

Это порт логики таблицы `Калькулятор_NEV` (Google Sheets / Excel) и её
Google Apps Script:

- **многоуровневая рецептура** — продукт раскладывается на полупродукты и
  сырьё, стоимость сворачивается снизу вверх;
- **многовалютные цены сырья** — пересчёт из RUB/USD/CNY в евро по кросс-курсам
  ЦБ РФ;
- **себестоимость €/кг и ₽/кг**, с НДС и без НДС, с учётом потерь;
- **загрузка курсов ЦБ РФ** с цепочкой источников (официальный XML → зеркала).

Ядро работает на чистой стандартной библиотеке Python 3.10+ — внешних
зависимостей нет. `openpyxl` нужен только для чтения «живой» книги `.xlsx`.

---

## Установка

```bash
git clone <repo-url>
cd nev-calculator

# только использование (ядро без зависимостей):
pip install .

# с поддержкой чтения .xlsx:
pip install ".[xlsx]"

# для разработки и тестов:
pip install ".[dev]"
```

Данные уже встроены в пакет (снимок из `Калькулятор_NEV_v9 (1).xlsx`,
файл `nev_calc/data/nev_data.json`), поэтому пакет работает «из коробки».

---

## Быстрый старт — как библиотека

```python
from nev_calc import Catalog, Calculator

cat = Catalog.from_json()          # встроенный снимок данных
calc = Calculator(cat)

res = calc.compute("Black (PBl 7) / RASTR", eur_rate=83.6892)

print(res.eur_no_vat)   # 3.12   — €/кг без НДС
print(res.eur_vat)      # 3.81   — €/кг с НДС
print(res.rub_no_vat)   # 261.11 — ₽/кг без НДС
print(res.rub_vat)      # 318.55 — ₽/кг с НДС

for ln in res.lines:
    print(ln.index, ln.component, ln.pct, ln.eur_no_vat)
```

Расчёт с потерями и ручным курсом:

```python
res = calc.compute(
    "Black (PBl 7) / RASTR",
    loss_pct=0.05,     # 5 % глобальных потерь (ячейка M11)
    eur_rate=90.0,     # переопределить курс EUR/RUB
)
```

### Чтение «живой» книги Excel

```python
cat = Catalog.from_xlsx("Калькулятор_NEV_v9 (1).xlsx")   # нужен openpyxl
calc = Calculator(cat)
```

> Excel читается с уже вычисленными значениями (`data_only`), поэтому файл
> должен быть хотя бы раз пересчитан и сохранён.

---

## Быстрый старт — как CLI

```bash
# себестоимость продукта с разбивкой по компонентам
python -m nev_calc cost "Black (PBl 7) / RASTR" --rate 83.6892

# с потерями 5 % и в режиме «живого» пересчёта цен полупродуктов
python -m nev_calc cost "Black (PBl 7) / RASTR" --loss 0.05 --live

# поиск по артикулу
python -m nev_calc cost --article 15038

# список продуктов с фильтром
python -m nev_calc products --filter black

# цена сырья / полупродукта
python -m nev_calc material "Этилцеллозольв"
python -m nev_calc semi "Extender SL-2 ЭЦ"

# курсы ЦБ: показать сохранённые / загрузить актуальный
python -m nev_calc rates
python -m nev_calc rates --update
python -m nev_calc rates --update --date 01.06.2026

# проверить доступность источников курсов
python -m nev_calc diagnose

# считать из живой книги Excel (любую команду)
python -m nev_calc cost "..." --xlsx "Калькулятор_NEV_v9 (1).xlsx"
```

После `pip install .` доступна короткая команда `nev-calc` вместо
`python -m nev_calc`.

---

## Модель расчёта

Себестоимость 1 кг продукта (лист «Калькулятор»):

```
для каждой компоненты рецептуры:
    доля%        = ручной ввод G  ИЛИ  базовый % из «Рецептуры»
    кол-во/кг    = ОКРУГЛ(доля% × (1 + потери%), 6)
    цена €/кг    = ручная цена M (если > 0)  ИЛИ  цена компоненты
    €/кг         = ОКРУГЛ(кол-во × цена, 2)
    ₽/кг         = ОКРУГЛ(€/кг × курс EUR/RUB, 2)

Σ себестоимость €/кг = ОКРУГЛ(сумма €/кг по компонентам, 2)
€/кг с НДС            = ОКРУГЛ(Σ × (1 + НДС), 2)      # НДС = 22 %
₽/кг без НДС          = ОКРУГЛ(Σ × курс, 2)
₽/кг с НДС            = ОКРУГЛ(Σ × (1 + НДС) × курс, 2)
```

**Цена компоненты:**

- *сырьё* — цена €/кг из каталога «Сырьё» (при необходимости пересчитанная
  из исходной валюты по курсу ЦБ на дату поступления);
- *полупродукт* — два режима (`PriceMode`):
  - `STORED` (по умолчанию) — закэшированная в таблице цена. **Точно
    воспроизводит числа из файла** (как `VLOOKUP` на листе «Калькулятор»);
  - `LIVE` — рекурсивный пересчёт цены полупродукта из его рецептуры и
    текущих цен сырья. Самосогласованно, реагирует на изменение цен/курсов.

Округление выполняется «как в Excel» (половина — от нуля), см.
`nev_calc.pricing.excel_round`.

---

## Курсы ЦБ РФ

Модуль `nev_calc.rates` — порт Apps Script (версия v7). Источники по приоритету:

1. Официальный XML ЦБ РФ — `https://www.cbr.ru/scripts/XML_daily.asp`
   (windows-1251, запятая-разделитель, учёт `<Nominal>`);
2. Зеркало `cbr-xml-daily.ru` (JSON, есть архив по датам);
3. Зеркало `cbr-xml-daily.com` (JSON).

```python
from datetime import date
from nev_calc.rates import fetch_rates_for_date, fetch_rates_range

r = fetch_rates_for_date()                 # последняя доступная дата
print(r.date, r.eur, r.usd, r.cny)

for d, rates in fetch_rates_range(date(2026, 6, 1), date(2026, 6, 5)):
    print(d, rates and rates.eur)
```

---

## Структура проекта

```
nev-calculator/
├── nev_calc/
│   ├── __init__.py        — публичный API
│   ├── models.py          — dataclass-модели листов
│   ├── catalog.py         — загрузка из JSON / xlsx + индексы
│   ├── pricing.py         — округление, валюты, свёртка себестоимости
│   ├── calculator.py      — высокоуровневый расчёт (лист «Калькулятор»)
│   ├── rates.py           — курсы ЦБ РФ (порт Apps Script)
│   ├── cli.py             — командный интерфейс
│   ├── __main__.py        — python -m nev_calc
│   └── data/nev_data.json — встроенный снимок данных
├── tests/                 — pytest (ценообразование, расчёт, курсы)
├── requirements.txt
├── pyproject.toml
└── README.md
```

---

## Тесты

```bash
pip install ".[dev]"
pytest
```

Тесты сверяют расчёт с эталонными числами из исходной таблицы
(продукт `Black (PBl 7) / RASTR` → 3.12 €/кг без НДС), проверяют пересчёт
валют, округление и цепочку источников курсов (без обращения к сети).

---

## Лицензия

MIT — см. [LICENSE](LICENSE).
