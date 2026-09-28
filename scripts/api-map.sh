#!/usr/bin/env bash
# Этап 1: карта ресурсов API (только GET, read-only).
#   bash scripts/api-map.sh store   # /store/*
#   bash scripts/api-map.sh admin   # /admin/* (требует ADMIN_EMAIL/ADMIN_PASSWORD в .env)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/config/targets.sh"

mode="${1:-store}"

# admin() ждёт путь без префикса /admin, api() — полный путь (с /store).
if [ "$mode" = "admin" ]; then
  ADMIN_TOKEN="$(admin_token)"
  probe() { admin GET "$1" -o /dev/null -w '%{http_code}'; }
else
  probe() { api GET "/store$1" -o /dev/null -w '%{http_code}'; }
fi

paths=(
  ""
  "?limit=1"
  "/products?limit=1"
  "/product-types?limit=1"
  "/product-tags?limit=1"
  "/collections?limit=1"
  "/regions?limit=1"
  "/carts"
  "/customers/me"
  "/orders"
  "/shipping-options"
  "/payment-providers"
  "/store"
  "/publishable-keys"
  "/api-keys"
  "/promotions?limit=1"
  "/campaigns?limit=1"
  "/inventory-items?limit=1"
  "/variants?limit=1"
  "/users?limit=1"
  "/auth/session"
)

for p in "${paths[@]}"; do
  code="$(probe "$p")"
  printf '%s  /%s%s\n' "$code" "$mode" "$p"
done
