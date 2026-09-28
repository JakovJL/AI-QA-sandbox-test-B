# Реестр тест-кейсов

> Индекс кейсов по областям риска (см. docs/PLAN.md §6). Детальные шаги — внутри кейса.

| ID | Область | Название | Тип (API/UI/NFR) | Статус | Дефект(ы) |
|----|---------|----------|------------------|--------|-----------|
| TC-001 | 1. Каталог и пагинация | count в `/store/products` при limit 1/2/10 | API | fail (28.09, контур Б) | BUG-001 ([issue #1](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/1)) |
| TC-002 | 4. Регионы/валюты | согласованность цены API ↔ корзина ↔ витрина (Sweatshirt, eur) | UI+API | fail→retracted (28.09: конвенция v2 — major units; BUG-002 отозван) | BUG-002 ([issue #2](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/2), retracted) |
| TC-003 | 11. UI-состояния | страница поиска `/dk/search?q=…` и вход в поиск из шапки | UI | fail (28.09, контуры А+Б) | BUG-003 ([issue #3](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/3)) |
| TC-004 | 1. Каталог/10. Ошибки | `limit=-1` в `/store/products` (валидация пагинации) | API | fail (28.09, этап 2.1; объединено с BUG-005) | BUG-005 |
| TC-008 | 10. Ошибки | фаззинг Schemathesis GET-листингов (мини-спека, лимиты §13.5) | API | fail: 5×500 при limit/offset<0 (28.09, этап 2.5) | BUG-005 ([issue #5](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/5)) |
| TC-009 | 10. Ошибки/14. Безопасность | NUL-байт в query-параметрах (cart_id, q) | API | fail: 500 при NUL; юникод без NUL — 404 (28.09, этап 2.5/репродукция) | BUG-006 ([issue #6](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/6)) |
| TC-010 | 6. Чекаут/11. UI | сабмит адресной формы в чекауте (контур А + серии в контуре Б: 5 десктоп + мобайл) | UI | fail (интермиттент, мобайл-воспроизводимый): 2/7 → /null/checkout → 404 (28.09, этап 3.3+3.5) | BUG-007 ([issue #7](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/7)) |
| TC-011 | 5. Доставка/6. Чекаут | список способов доставки на шаге delivery | UI | fail: radiogroup пустая, Continue to payment disabled (28.09, этап 3.3, десктоп+мобайл) | BUG-008 ([issue #8](https://github.com/JakovJL/AI-QA-sandbox-test-B/issues/8)) |
| TC-012 | 1. Каталог/11. UI | клиентские фетчи 127.0.0.1:9001 и /blocking-fault.js; сортировки sortBy | UI | fail/pass-контраст (28.09, контур Б) | BUG-008 (причина), наблюдения |
| TC-005 | 1. Каталог | пагинация/фильтры/сортировка/fields каталога (13 проверок) | API | pass (28.09, этап 2.1) | — |
| TC-006 | 2. Корзина | негативные входы корзины (12 проверок) | API | pass (28.09, этап 2.2) | — |
| TC-007 | 6. Чекаут | полный пайплайн + идемпотентность complete (7 проверок) | API | pass (28.09, этап 2.3) | — |
