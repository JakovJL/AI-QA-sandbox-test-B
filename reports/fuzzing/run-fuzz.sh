#!/usr/bin/env bash
# Этап 2.5: фаззинг Schemathesis в согласованных лимитах (§13.5 плана):
#   - только GET-эндпоинты мини-спеки (мутаций нет);
#   - <= 30 запросов/мин; <= 50 кейсов на эндпоинт; 1 воркер.
# Спека указывает на живую цель через --api-base-url.
# Запуск: bash reports/fuzzing/run-fuzz.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/config/targets.sh"

ST="$APPDATA/Python/Python313/Scripts/schemathesis.exe"
mkdir -p "$ROOT/reports/fuzzing"
OUT="$ROOT/reports/fuzzing/stage2.5-$(date +%Y%m%d-%H%M%S).json"

"$ST" run "$ROOT/scripts/schemas/store-mini-openapi.json" \
  --url "https://$TARGET_HOST" \
  -H "x-publishable-api-key: $PUBLISHABLE_KEY" \
  --checks not_a_server_error \
  --phases examples,fuzzing \
  --max-examples 20 \
  --rate-limit 30/m \
  --workers 1 \
  --max-failures 5 \
  --report json \
  --report-dir "$ROOT/reports/fuzzing/schemathesis-report" \
  2>&1 | tee "$ROOT/reports/fuzzing/last-run.log"

echo "JSON-отчёт: $OUT (лог: reports/fuzzing/last-run.log)"
