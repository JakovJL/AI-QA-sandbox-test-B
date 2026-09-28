# Карта эндпоинов и страниц — Этап 1 (снята 28.09.2026)

> Read-only зондирование: `scripts/api-map.sh` (Store/Admin), `scripts/pages-map.sh` (витрина).
> Это базовая линия, не багрепорт: 404 у несуществующих путей — норма; аномалии вынесены ниже.

## Store API (GET, с publishable key)

| Код | Путь | Комментарий |
|---|---|---|
| 200 | `/store/products` | каталог открыт; 2 товара, count корректный |
| 200 | `/store/product-types`, `/store/product-tags`, `/store/collections`, `/store/regions` | справочники открыты; коллекций 0 |
| 200 | `/store/product-categories` | категории: shirts, sweatshirts, pants |
| 401 | `/store/customers/me`, `/store/orders` | требуют аутентификацию покупателя — соответствует доке v2 |
| 400 | `/store/shipping-options`, `/store/payment-providers` | требуют контекст корзины (`cart_id`) |
| 404 | `/store/promotions`, `/store/campaigns`, `/store/inventory-items`, `/store/variants`, `/store/api-keys`, `/store/carts` (GET-лист) | не выставлены в Store-скоуп — ожидаемо |

## Admin API (GET, Bearer JWT)

| Код | Путь | Комментарий |
|---|---|---|
| 200 | `/admin/products`, `/admin/product-types`, `/admin/product-tags`, `/admin/collections`, `/admin/regions` | каталог и справочники |
| 200 | `/admin/orders` | заказы (список существует, проверяется на этапе 2) |
| 200 | `/admin/stores` | **в v2 ресурс — `/admin/stores` (множественное); 404 на `/admin/store` — неверное ожидание от v1, НЕ кандидат** |
| 200 | `/admin/promotions`, `/admin/campaigns` | промо-модуль есть (в системе пусто) |
| 200 | `/admin/users`, `/admin/api-keys`, `/admin/inventory-items`, `/admin/shipping-options` | управленческие ресурсы |
| 404 | `/admin/carts`, `/admin/variants`, `/admin/customers/me` | вероятно, соответствует v2 (листинга корзин/вариантов в админ-скоупе нет) — финальная сверка на этапе 2 |
| 404 | `/admin/payment-providers` (и `/admin/regions/{id}/payment-providers`) | **уточнено 28.09:** маршрут не зарегистрирован в сборке (Express «Cannot GET»), тело — HTML; сверить с докой и версией Medusa на этапе 2 — кандидат на перепроверку |

## Страницы витрины (Next.js starter, `/dk` — активный регион)

| Код | Путь | Комментарий |
|---|---|---|
| 200 | `/dk` | главная |
| 200 | `/dk/store` | каталог-листинг (индекс категорий `/dk/categories` — 404) |
| 200 | `/dk/categories/shirts` (и др. хэндлы) | категории работают |
| 200 | `/dk/products/sweatshirt`, `/dk/products/t-shirt` | карточки товаров |
| 200 | `/dk/cart`, `/dk/account` | корзина и аккаунт (гостем) |
| **404** | **`/dk/search?q=shirt` и `?q=`** | **кандидат №0 подтверждён на уровне HTTP; посмотреть, есть ли иконка поиска в шапке (контур А)** |
| 404 | `/dk/collections/apparel`, `/dk/order/confirmed/xxx`, `/dk/products/nonexistent-handle-qa` | ожидаемые 404 |
| 200 | `/robots.txt`, `/sitemap.xml` | SEO-эндпоинты есть (содержимое — этап NFR) |
| 404 | `/api/health` | health-маршрут витрины отсутствует |

## Аномалии метода (наблюдение)

- Одиночные запросы: 200; при быстрой серии — 307-редиректы на корень. Не стабильно
  воспроизводится; похоже на edge-слой (похоже на защиту/лимит), перепроверить в NFR-этапе.

## Приоритизация областей риска (14 из PLAN §7, срез под наблюдаемую систему)

**P1 (данные/деньги, есть живая поверхность):**
1. Корзина: создание/элементы/границы (Store `POST/GET` корзины — поверхность открыта).
2. Чекаут: сессии, завершение, повторные вызовы (мок-провайдер, без реальной оплаты).
3. Доставка/оплата: `shipping-options`/`payment-providers` при `cart_id` — что реально настроено.
4. Инвентарь и варианты: `manage_inventory=true` у всех вариантов, варианты Sweatshirt правились руками.

**P2 (контракты и рассогласования):**
5. Каталог/пагинация: `count/offset/limit`, фильтры (в т.ч. `tag_id`, существующий `bug-demo-tag`).
6. Контракты и ошибки API: формы ошибок 400/401/404, `promotion_total` в корзине.
7. Регионы/валюты: `$` на `/dk` при `eur` в регионе Europe (кандидат из разведки).
8. Аутентификация покупателя: регистрация/логин (маркированные данные `@test.local`).
9. Админка/изоляция Store↔Admin: что видно Store без ключа, что Admin.

**P3 (периферия для этого sandbox):**
10. Промокоды: поверхность пустая (0 прайс-листов/промо) — только контракты ошибок.
11. UI-состояния: поиск 404, пустые коллекции, счётчик категорий.
12. NFR-области (перф, заголовки, rate-limit, доступность) — этапы 3–4.
