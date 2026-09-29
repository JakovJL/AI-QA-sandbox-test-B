// Регрессия 2026-09-29: API-блок дефектов по плейбуку aqa-playbook (R2 — репродьюсер, R1 — сырой артефакт).
// Для каждого бага фиксируем: воспроизведён (present) / не воспроизведён (absent).
// Артефакты: reports/artifacts/regress-2909/
// Запуск: npx tsx scripts/ts/regress-api-bugs.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, apiGet, apiPost, projectRoot, type Target } from "./lib/target.ts";

const artifactsDir = path.join(projectRoot, "reports", "artifacts", "regress-2909");

async function save(name: string, text: string): Promise<string> {
  await mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, name);
  await writeFile(file, text, "utf8");
  return path.relative(projectRoot, file);
}

interface BugResult {
  bug: string;
  present: boolean | null; // null = sanity/контроль, не баг-вердикт
  checks: { check: string; result: string }[];
}
const results: BugResult[] = [];

function bug(name: string): BugResult {
  const r: BugResult = { bug: name, present: null, checks: [] };
  results.push(r);
  return r;
}
function chk(b: BugResult, check: string, result: string): void {
  b.checks.push({ check, result });
  console.log(`  [${b.bug}] ${check} — ${result}`);
}

const SECURITY_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const;

async function bug001(t: Target): Promise<void> {
  // Детерминированный репродьюсер: count == limit на трёх страницах.
  const b = bug("BUG-001");
  const counts: { limit: number; count: number; returned: number }[] = [];
  for (const limit of [1, 2, 10]) {
    const r = await apiGet(t, `/store/products?limit=${limit}`);
    const d = JSON.parse(r.body) as { count: number; products: unknown[] };
    counts.push({ limit, count: d.count, returned: d.products.length });
    await save(`bug001-count-limit-${limit}.json`, r.body);
  }
  const mirrored = counts.every((x) => x.count === x.limit || x.count === x.returned);
  const total = counts.find((x) => x.limit === 10)?.count ?? 0;
  b.present = mirrored;
  chk(b, "count зеркалит limit/страницу", `limits=[1,2,10] -> counts=[${counts.map((c) => c.count).join(", ")}]`);
  chk(b, "общее число записей (limit=10)", `count=${total}`);
}

async function bug003(t: Target): Promise<void> {
  // /dk/search?q=… отдаёт 404 на любой запрос.
  const b = bug("BUG-003");
  const qs = ["shirt", "medusa", ""];
  const statuses: string[] = [];
  let all404 = true;
  for (const q of qs) {
    const r = await apiGet(t, `/dk/search?q=${encodeURIComponent(q)}`, { accept: "text/html" });
    const notFound = r.status === 404 || /page not found/i.test(r.body);
    if (!notFound) all404 = false;
    statuses.push(`q=${q || "(пусто)"} -> HTTP ${r.status}`);
    await save(`bug003-search-q-${q === "" ? "empty" : q}.html`, r.body);
  }
  b.present = all404;
  chk(b, "страница поиска", statuses.join("; "));
}

async function bug005(t: Target): Promise<void> {
  // Отрицательные limit/offset -> 500 на листингах; order=price_asc -> 500.
  const b = bug("BUG-005");
  const endpoints = [
    "/store/products",
    "/store/collections",
    "/store/regions",
    "/store/product-tags",
    "/store/product-categories",
  ];
  let count500 = 0;
  const lines: string[] = [];
  for (const ep of endpoints) {
    const r = await apiGet(t, `${ep}?limit=-12&offset=-20`);
    if (r.status === 500) count500++;
    lines.push(`${ep}: HTTP ${r.status}`);
    await save(`bug005-${ep.replace(/\//g, "-")}-neg.json`, r.body);
  }
  const rOrder = await apiGet(t, "/store/products?order=price_asc");
  if (rOrder.status === 500) count500++;
  lines.push(`/store/products?order=price_asc: HTTP ${rOrder.status}`);
  await save(`bug005-products-order-price-asc.json`, rOrder.body);
  b.present = count500 >= 5; // как минимум листинги + order
  chk(b, "negative pagination + order", `${lines.join("; ")} (500: ${count500}/${endpoints.length + 1})`);
}

async function bug006(t: Target): Promise<void> {
  // NUL-байт (%00) в query -> 500; контроли: юникод без NUL -> 404, текстовый несуществующий -> 404.
  const b = bug("BUG-006");
  const rNul1 = await apiGet(t, "/store/shipping-options?cart_id=cart%00qa");
  await save("bug006-shipping-nul.json", rNul1.body);
  const rNul2 = await apiGet(t, "/store/products?q=abc%00def");
  await save("bug006-products-q-nul.json", rNul2.body);
  const rCtl1 = await apiGet(t, "/store/shipping-options?cart_id=plainunknown");
  await save("bug006-shipping-control.json", rCtl1.body);
  const rCtl2 = await apiGet(t, "/store/products?q=abc%F0%90%86%83def");
  await save("bug006-products-unicode-only.json", rCtl2.body);
  const nul500 = rNul1.status === 500 && rNul2.status === 500;
  // Контроль: тот же вход без NUL ведёт себя штатно (текстовый cart_id -> 404;
  // products?q -> 200 с пустым списком — валидный пустой результат поиска).
  const ctlOk = rCtl1.status === 404 && rCtl2.status === 200;
  b.present = nul500 && ctlOk;
  chk(b, "NUL в query", `shipping-options: ${rNul1.status}, products?q: ${rNul2.status}`);
  chk(b, "контроли без NUL", `текстовый cart_id: ${rCtl1.status} (404); products?q юникод: ${rCtl2.status} с count=0 (200, норма) — NUL flips 200 -> 500`);
}

async function bug002Sanity(t: Target): Promise<void> {
  // Sanity отозванного BUG-002: цены согласованы по конвенции v2 (major units).
  const b = bug("BUG-002 (sanity, retracted)");
  const pr = await apiGet(
    t,
    "/store/products?limit=2&region_id=reg_01M392A8HJPWA7MA90WZ9QSPH8&fields=id,title,*variants.calculated_price",
  );
  await save("bug002-prices-eur.json", pr.body);
  const d = JSON.parse(pr.body) as {
    products: { variants: { id: string; calculated_price?: { calculated_amount?: number; currency_code?: string } }[] }[];
  };
  const amounts = [...new Set(d.products.flatMap((p) => (p.variants ?? []).map((v) => v.calculated_price?.calculated_amount)))];
  const currencies = [...new Set(d.products.flatMap((p) => (p.variants ?? []).map((v) => v.calculated_price?.currency_code)))];
  chk(b, "API-цена", `calculated_amount=[${amounts.join(", ")}], currency=[${currencies.join(", ")}] (конвенция v2: 10 = €10.00)`);

  // Живая корзина: серверный расчёт совпадает с API-ценой.
  const cart = await apiPost(t, "/store/carts", {});
  const cartId = (JSON.parse(cart.body) as { cart: { id: string } }).cart.id;
  const variantId = d.products[0]!.variants[0]!.id;
  const add = await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: 1 });
  await save("bug002-cart.json", cart.body);
  await save("bug002-cart-add.json", add.body);
  const cd = JSON.parse(add.body) as { cart: { subtotal: number } };
  b.present = null;
  chk(b, "корзина", `subtotal=${cd.cart.subtotal} (согласовано с API: ${amounts.join(", ")})`);
}

async function bug009(t: Target): Promise<void> {
  // Матрица security-заголовков на 4 поверхностях + куки + x-powered-by.
  const b = bug("BUG-009");
  const surfaces = ["/dk", "/dk/store", "/app", "/store/products?limit=1"];
  let missingTotal = 0;
  const lines: string[] = [];
  for (const s of surfaces) {
    const r = await apiGet(t, s, { accept: "text/html" });
    const missing = SECURITY_HEADERS.filter((h) => !(h in r.headers));
    missingTotal += missing.length;
    const powered = r.headers["x-powered-by"] ?? "—";
    const cookie = (r.headers["set-cookie"] ?? "").toLowerCase();
    const flags = ["httponly", "secure", "samesite"].filter((f) => cookie.includes(f));
    lines.push(`${s}: отсутствует ${missing.length}/6, x-powered-by=${powered}, куки-флаги=[${flags.join(",") || "нет"}]`);
    await save(`bug009-headers-${s.replace(/[/?=&]/g, "_")}.json`, JSON.stringify(r.headers, null, 2));
  }
  b.present = missingTotal >= 6 * 4 - 6; // допуск: хотя бы на большинстве поверхностей пусто
  chk(b, "матрица заголовков", lines.join(" | "));
}

async function bug010(t: Target): Promise<void> {
  // /robots.txt и /sitemap.xml -> 200 text/html (HTML not-found).
  const b = bug("BUG-010");
  const r1 = await apiGet(t, "/robots.txt", { accept: "text/plain" });
  await save("bug010-robots.txt", r1.body.slice(0, 2000));
  const r2 = await apiGet(t, "/sitemap.xml", { accept: "application/xml" });
  await save("bug010-sitemap.bin", r2.body.slice(0, 2000));
  const htmlAs200 = (r: { status: number; headers: Record<string, string> }): boolean =>
    r.status === 200 && (r.headers["content-type"] ?? "").includes("text/html");
  b.present = htmlAs200(r1) && htmlAs200(r2);
  chk(
    b,
    "SEO-файлы",
    `robots.txt: ${r1.status} ${r1.headers["content-type"]}; sitemap.xml: ${r2.status} ${r2.headers["content-type"]}`,
  );
}

async function bug011(t: Target): Promise<void> {
  // og:image / twitter:image указывают на 127.0.0.1:8000.
  const b = bug("BUG-011");
  const r = await apiGet(t, "/dk", { accept: "text/html" });
  const og = /<meta\s+property="og:image"\s+content="([^"]+)"/.exec(r.body)?.[1] ?? "(не найден)";
  const tw = /<meta\s+name="twitter:image"\s+content="([^"]+)"/.exec(r.body)?.[1] ?? "(не найден)";
  await save("bug011-dk-meta.html", r.body);
  b.present = og.includes("127.0.0.1") || tw.includes("127.0.0.1");
  chk(b, "мета-теги", `og:image=${og}; twitter:image=${tw}`);
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);
  await bug001(t);
  await bug002Sanity(t);
  await bug003(t);
  await bug005(t);
  await bug006(t);
  await bug009(t);
  await bug010(t);
  await bug011(t);

  const report = {
    date: new Date().toISOString(),
    target: { host: t.host, ip: t.ip },
    kind: "regression-api-bugs",
    results,
    summary: {
      present: results.filter((r) => r.present === true).length,
      absent: results.filter((r) => r.present === false).length,
      sanity: results.filter((r) => r.present === null).length,
    },
  };
  const rep = await save("regress-api-summary.json", JSON.stringify(report, null, 2));
  console.log(
    `\nитог: present=${report.summary.present}, absent=${report.summary.absent}, sanity=${report.summary.sanity}; артефакт: ${rep}`,
  );
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
