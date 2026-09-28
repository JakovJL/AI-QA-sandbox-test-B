#!/usr/bin/env bash
# Этап 1: карта страниц витрины (GET, read-only).
#   bash scripts/pages-map.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "$ROOT/config/targets.sh"

probe() {
  # $1 - путь; печатает "код финального_урла"
  "${CURL_BASE[@]}" -o /dev/null -w '%{http_code} %{url_effective}\n' -L --max-redirs 3 "$1"
}

paths=(
  "/dk"
  "/dk/search?q=shirt"
  "/dk/search?q="
  "/dk/categories"
  "/dk/categories/shirts"
  "/dk/products/sweatshirt"
  "/dk/products/t-shirt"
  "/dk/products/nonexistent-handle-qa"
  "/dk/collections/apparel"
  "/dk/cart"
  "/dk/account"
  "/dk/order/confirmed/xxx"
  "/us/store/products?limit=1"
  "/robots.txt"
  "/sitemap.xml"
  "/api/health"
)

for p in "${paths[@]}"; do
  probe "https://$TARGET_HOST$p"
done
