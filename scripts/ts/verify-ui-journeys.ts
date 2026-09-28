// Этап 3.5: детерминизация UI-находок (контур Б, headless chromium).
// Проверки:
//   A) клиентский фетч на http://127.0.0.1:9001 (смешанный контент/локалхост)
//   B) блокировка /blocking-fault.js на страницах
//   C) варианты товара disabled до взаимодействия ("Select Options")
//   D) сортировки sortBy=price_asc/price_desc не меняют порядок (все цены равны; API-400 на order=price_*)
//   E) чекаут-редирект на /null/checkout после сабмита адресной формы
// Запуск: npx tsx scripts/ts/verify-ui-journeys.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolveTarget, projectRoot, type Target } from "./lib/target.ts";

const artifacts = path.join(projectRoot, "reports", "artifacts");
async function save(name: string, text: string): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  const file = path.join(artifacts, name);
  await writeFile(file, text, "utf8");
  return path.relative(projectRoot, file);
}

interface Line { check: string; pass: boolean | null; detail: string }
const lines: Line[] = [];
function rec(check: string, pass: boolean | null, detail: string): void {
  lines.push({ check, pass, detail });
  console.log(`[${pass === null ? "info" : pass ? "PASS" : "FAIL"}] ${check} — ${detail}`);
}

async function withPage(
  t: Target,
  fn: (page: import("playwright").Page) => Promise<void>,
): Promise<void> {
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  try {
    const page = await browser.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  const base = `https://${t.host}`;
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  // --- A+B: localhost-фетчи и blocking-fault на /dk/store ---
  await withPage(t, async (page) => {
    const localhostHits: string[] = [];
    const faultHits: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith("http://127.0.0.1")) localhostHits.push(r.url());
      if (r.url().includes("blocking-fault")) faultHits.push(r.url());
    });
    await page.goto(`${base}/dk/store`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(3000);
    rec(
      "A: клиент дёргает http://127.0.0.1:9001 (product-options)",
      localhostHits.length > 0,
      `${localhostHits.length} запросов, напр.: ${localhostHits[0] ?? "—"}`,
    );
    rec("B: /blocking-fault.js загружается на страницах", faultHits.length > 0, `${faultHits.length} загрузок`);
    await save("stage3-localhost-fetches.json", JSON.stringify(localhostHits, null, 2));
  });

  // --- C: варианты disabled до "Select Options" ---
  await withPage(t, async (page) => {
    await page.goto(`${base}/dk/products/sweatshirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(6000);
    const sizeButtons = page.locator('main button', { hasText: /^(S|M|L|XL)$/ });
    const n = await sizeButtons.count();
    let disabledCount = 0;
    for (let i = 0; i < n; i++) {
      if (await sizeButtons.nth(i).isDisabled()) disabledCount++;
    }
    rec(
      "C: при первом рендере карточки кнопки вариантов disabled",
      n > 0 && disabledCount === n,
      `${disabledCount}/${n} disabled до «Select Options»`,
    );
    const shot = path.join(projectRoot, "reports", "screenshots", "stage3-variants-disabled.png");
    await page.screenshot({ path: shot });
  });

  // --- D: сортировки ---
  await withPage(t, async (page) => {
    await page.goto(`${base}/dk/store?limit=10`, { waitUntil: "networkidle", timeout: 60_000 });
    const getOrder = async () =>
      page.locator('main a[href*="/products/"]').evaluateAll((els) => els.map((e) => e.getAttribute("href")));
    const before = await getOrder();
    await page.goto(`${base}/dk/store?limit=10&sortBy=price_desc`, { waitUntil: "networkidle", timeout: 60_000 });
    const after = await getOrder();
    rec(
      "D: sortBy=price_desc не меняет порядок (цены равны; API order=price_desc -> 500)",
      JSON.stringify(before) === JSON.stringify(after),
      `до=[${before.join(",")}] после=[${after.join(",")}]`,
    );
  });

  // --- E: чекаут-редирект на /null ---
  await withPage(t, async (page) => {
    await page.goto(`${base}/dk/products/sweatshirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8000);
    // Разблокировать варианты: "Select Options" -> выбор S -> Add to cart
    const selectOptions = page.locator("main button", { hasText: "Select Options" }).first();
    await selectOptions.waitFor({ state: "attached", timeout: 30_000 });
    await selectOptions.click({ force: true });
    await page.waitForTimeout(1500);
    await page.locator('main button', { hasText: /^S$/ }).first().click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Add to cart" }).first().click();
    await page.waitForTimeout(3000);
    await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.getByRole("button", { name: /go to checkout/i }).click();
    await page.waitForTimeout(3000);

    // Заполнить адресную форму
    const set = async (name: string, val: string) => {
      const el = page.locator(`main input[name="${name}"]`);
      await el.fill(val);
    };
    await set("shipping_address.first_name", "QA");
    await set("shipping_address.last_name", "Marker");
    await set("shipping_address.address_1", "Test Lane 1");
    await set("shipping_address.postal_code", "1000");
    await set("shipping_address.city", "Kobenhavn");
    await set("email", "qa-ui-journey@test.local");
    await page.getByRole("button", { name: /continue to delivery/i }).click();
    await page.waitForTimeout(5000);

    const url = page.url();
    const isNullRedirect = url.includes("/null/");
    rec(
      "E: сабмит адреса ведёт на /null/checkout (потеря регион-префикса)",
      isNullRedirect,
      `url=${url}`,
    );
    const shot = path.join(
      projectRoot,
      "reports",
      "screenshots",
      "stage3-null-checkout.png",
    );
    await page.screenshot({ path: shot });
    await save("stage3-checkout-final-url.txt", url);
  });

  // --- Сводка ---
  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "3.5 UI journeys (contour B)",
    summary: { total: lines.length, failed: failed.length },
    lines,
  };
  const rep = await save(
    `stage3.5-ui-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
