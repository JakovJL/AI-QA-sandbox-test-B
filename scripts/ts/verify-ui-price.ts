// Контур Б: детерминированная фиксация цены на витрине (кандидат ×100).
// Открывает карточку товара в headless chromium (обход DNS через host-resolver-rules),
// извлекает отображаемую цену и сохраняет скриншот в reports/screenshots/.
// Запуск: npx tsx scripts/ts/verify-ui-price.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolveTarget, projectRoot } from "./lib/target.ts";

async function main(): Promise<void> {
  const t = await resolveTarget();
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  try {
    const page = await browser.newPage();
    const url = `https://${t.host}/dk/products/sweatshirt`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.waitForSelector("main", { timeout: 30_000 });
    // Дождаться рендера цен (SSR-гидрация может добавлять их асинхронно)
    await page.waitForFunction(
      () => /[€$]\s?\d/.test(document.querySelector("main")?.innerText ?? ""),
      { timeout: 30_000 },
    );

    const text = await page.locator("main").innerText();
    const prices = [...text.matchAll(/[€$]\s?\d+[\.,]?\d*/g)].map((m) => m[0]);
    const shotsDir = path.join(projectRoot, "reports", "screenshots");
    await mkdir(shotsDir, { recursive: true });
    const shot = path.join(shotsDir, `price-sweatshirt-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false });

    const result = {
      date: new Date().toISOString(),
      url,
      pricesOnPage: prices,
      expectedFromApi: "10 minor units (eur) = €0.10",
      screenshot: path.relative(projectRoot, shot),
    };
    const out = path.join(projectRoot, "reports", "artifacts", `ui-price-${Date.now()}.json`);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, JSON.stringify(result, null, 2), "utf8");

    console.log(`[info] цены на странице: ${JSON.stringify(prices)}`);
    console.log(`[info] ожидание от API: €0.10 (10 минорных)`);
    console.log(`[info] скриншот: ${path.relative(projectRoot, shot)}`);
    const mismatch = prices.some((p) => p.replace(/\s/g, "") === "€10.00");
    if (mismatch) {
      console.log("[FAIL] витрина показывает €10.00 — расхождение с API (×100) подтверждено в контуре Б");
      process.exit(1);
    } else {
      console.log("[PASS] расхождения €10.00 не обнаружено (поведение изменилось?)");
    }
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
