# AI-QA sandbox test

Тестирование sandbox-магазина (Medusa v2 + Next.js storefront) через AI: агентное исследование,
MCP-инструменты, детерминированное подтверждение находок. План и процесс — `docs/PLAN.md`.
Язык автоматизации — TypeScript; bash-скрипты остаются для ручных запросов.

## Структура

```
docs/PLAN.md            программа тестирования (этапы, области, методология)
docs/00-environment.md  окружение: DNS-блокировка провайдера и обход
config/targets.sh       харнесс доступа к цели (--resolve через DoH, режим определяется автоматически)
scripts/resolve-doh.sh  реальный IP цели + сравнение с DNS провайдера
scripts/api.sh          ручные запросы к Store/Admin API
registry/               реестры: требования-по-наблюдению, допущения, кейсы
reports/templates/      шаблоны: багрепорт, сводный отчёт прогона
reports/bugs/           багрепорты BUG-XXX (появятся по ходу этапов)
```

## Быстрый старт

```bash
bash scripts/resolve-doh.sh          # реальный IP цели (обход DNS-фильтра провайдера)
bash scripts/api.sh GET '/store/products?limit=2'
bash scripts/api.sh --admin GET '/products?limit=1'
```

### TypeScript-контур (npm)

```bash
npm install                      # playwright, @medusajs/js-sdk, ajv/zod, MCP, tsx
npx playwright install chromium  # контур Б (~150 МБ)
npm run verify                   # smoke Store API (TS, --resolve через pinned IP)
npx tsx scripts/ts/smoke-browser.ts   # smoke контура Б (headless chromium + обход DNS)
npm run typecheck                # tsc --noEmit
```

Секреты — в локальном `.env` (в git не попадает; шаблон — `.env.example`).
