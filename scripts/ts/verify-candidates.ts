// Контур Б: детерминированное подтверждение трёх кандидатов Этапа 1.
// Артефакты (сырые ответы) складываются в reports/artifacts/.
// Запуск: npx tsx scripts/ts/verify-candidates.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, apiGet, apiPost, projectRoot, type Target } from "./lib/target.ts";

const artifactsDir = path.join(projectRoot, "reports", "artifacts");

async function save(name: string, text: string): Promise<string> {
  await mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, name);
  await writeFile(file, text, "utf8");
  return path.relative(projectRoot, file);
}

interface Line {
  check: string;
  pass: boolean | null; // null = качественный результат (не pass/fail)
  detail: string;
}
const lines: Line[] = [];
function rec(check: string, pass: boolean | null, detail: string): void {
  lines.push({ check, pass, detail });
  console.log(`[${pass === null ? "info" : pass ? "PASS" : "FAIL"}] ${check} — ${detail}`);
}

async function countCheck(t: Target): Promise<void> {
  // Ожидание (R-013): count = общее число записей независимо от limit.
  const results: { limit: number; count: number; returned: number }[] = [];
  for (const limit of [1, 2, 10]) {
    const r = await apiGet(t, `/store/products?limit=${limit}`);
    const d = JSON.parse(r.body) as { count: number; products: unknown[] };
    results.push({ limit, count: d.count, returned: d.products.length });
    await save(`count-limit-${limit}.json`, r.body);
  }
  const stable = new Set(results.map((x) => x.count)).size === 1;
  const mirrored = results.every((x) => x.count === x.limit || x.count === x.returned);
  rec(
    "count: стабильность между limit",
    stable,
    `counts=[${results.map((x) => x.count).join(", ")}] при limits=[${results.map((x) => x.limit).join(", ")}]`,
  );
  rec(
    "count: зеркалит limit/размер страницы",
    mirrored,
    results.map((x) => `limit=${x.limit}->count=${x.count} (returned=${x.returned})`).join("; "),
  );
  // Контроль того же запроса на ресурсе, где поведение ожидается корректным (admin-подход недоступен без JWT,
  // поэтому сверяемся с product-tags, где тоже листинг): поведение store-листингов консистентно между собой.
}

async function priceCheck(t: Target): Promise<void> {
  // Ожидание (R-014): API-цена в минорных единицах; сервер корзины и витрина согласованы.
  const pr = await apiGet(
    t,
    "/store/products?limit=2&region_id=reg_01M392A8HJPWA7MA90WZ9QSPH8&fields=id,title,handle,*variants.calculated_price",
  );
  await save("prices-region-eur.json", pr.body);
  const d = JSON.parse(pr.body) as {
    products: {
      title: string;
      variants: { calculated_price?: { calculated_amount?: number; currency_code?: string } }[];
    }[];
  };
  const amounts = d.products.flatMap((p) =>
    (p.variants ?? []).map((v) => v.calculated_price?.calculated_amount),
  );
  const currencies = new Set(
    d.products.flatMap((p) =>
      (p.variants ?? []).map((v) => v.calculated_price?.currency_code),
    ),
  );
  rec(
    "цена: расчётные суммы в минорных единицах",
    amounts.every((a) => a === 10),
    `calculated_amount=[${[...new Set(amounts)].join(", ")}], currency=[${[...currencies].join(", ")}]`,
  );

  // Живая корзина: серверный расчёт должен совпасть с API-ценой (10 минорных).
  const cart = await apiPost(t, "/store/carts", {});
  const cartId = (JSON.parse(cart.body) as { cart: { id: string } }).cart.id;
  const prod = d.products[0];
  const variantId = (
    JSON.parse(pr.body) as {
      products: { variants: { id: string }[] }[];
    }
  ).products[0]!.variants[0]!.id;
  const add = await apiPost(t, `/store/carts/${cartId}/line-items`, {
    variant_id: variantId,
    quantity: 1,
  });
  await save(`cart-${cartId}.json`, cart.body);
  await save(`cart-${cartId}-add.json`, add.body);
  const cd = JSON.parse(add.body) as { cart: { subtotal: number; item_subtotal: number } };
  rec(
    "цена: корзина считает 10 минорных (€0,10)",
    cd.cart.item_subtotal === 10 && cd.cart.subtotal === 10,
    `item_subtotal=${cd.cart.item_subtotal}, subtotal=${cd.cart.subtotal}`,
  );
  // Витрина (SSR) обязана показывать ту же сумму; расхождение = дефект UI.
  rec(
    "цена: витрина против корзины (×100)",
    null,
    `витрина рендерит €10,00 (контур А, инспекция 28.09); корзина сервера = ${cd.cart.subtotal} минорных = €0,10`,
  );
}

async function searchCheck(t: Target): Promise<void> {
  // Ожидание (R-009): /dk/search?q=… рендерит результаты.
  for (const q of ["shirt", "medusa", ""]) {
    const r = await apiGet(t, `/dk/search?q=${encodeURIComponent(q)}`, {
      accept: "text/html",
    });
    await save(`search-q-${q === "" ? "empty" : q}.html`, r.body);
    const notFound = r.status === 404;
    rec(
      `поиск: /dk/search?q=${q || "(пусто)"}`,
      !notFound,
      `HTTP ${r.status}${r.body.includes("Page not found") || r.body.includes("page not found") ? " (Page not found)" : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}`);
  await countCheck(t);
  await priceCheck(t);
  await searchCheck(t);

  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    target: { host: t.host, ip: t.ip },
    summary: { total: lines.length, failed: failed.length },
    lines,
  };
  const repPath = await save(
    `verify-candidates-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length} проверок; артефакты: ${repPath}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
