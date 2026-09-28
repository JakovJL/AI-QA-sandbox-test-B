// BUG-007: серия из 5 гостевых чекаут-прогонов в контуре Б.
// Фиксируем URL после сабмита адресной формы в каждом прогоне:
//   /null/... -> редирект воспроизведён; /dk/... -> чистый проход.
// Каждый прогон: новая корзина -> add to cart -> cart -> checkout -> форма -> submit.
// Запуск: npx tsx scripts/ts/verify-bug007-series.ts
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

async function runOnce(t: Target, n: number): Promise<{ run: number; finalUrl: string; nullRedirect: boolean; note: string }> {
  const base = `https://${t.host}`;
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  try {
    const page = await browser.newPage();
    // 1. Карточка товара, выбор S через модалку, add to cart (десктоп-вьюпорт!)
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`${base}/dk/products/sweatshirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const selBtn = page.locator('button[data-testid="mobile-actions-button"]').first();
    await selBtn.waitFor({ state: 'attached', timeout: 45_000 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Select Options');
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const dlg = document.querySelector('[role=dialog]');
      const s = dlg ? [...dlg.querySelectorAll('button')].find(x => x.innerText.trim() === 'S') : null;
      if (s) s.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const add = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === 'Add to cart');
      if (add) add.click();
    });
    await page.waitForTimeout(3000);

    // 2. Корзина -> чекаут
    await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.locator("button", { hasText: /go to checkout/i }).first().click();
    await page.waitForTimeout(3000);
    const startUrl = page.url();

    // 3. Если уже на delivery (адрес мог сохраниться в чужой корзине cookie) — фиксируем как pass-through
    if (page.url().includes("step=delivery")) {
      return { run: n, finalUrl: page.url(), nullRedirect: false, note: "delivery сразу (корзина уже с адресом)" };
    }

    // 4. Форма адреса
    const set = async (name: string, val: string) => {
      await page.locator(`main input[name="${name}"]`).fill(val);
    };
    await set("shipping_address.first_name", `QA${n}`);
    await set("shipping_address.last_name", "Series");
    await set("shipping_address.address_1", "Test Lane 1");
    await set("shipping_address.postal_code", "1000");
    await set("shipping_address.city", "Kobenhavn");
    await set("email", `qa-series${n}@test.local`);

    await page.evaluate(() => {
      const cont = [...document.querySelectorAll<HTMLButtonElement>('main button')].find(b => /continue to delivery/i.test(b.innerText));
      if (cont) cont.click();
    });
    await page.waitForTimeout(5000);

    const finalUrl = page.url();
    const nullRedirect = finalUrl.includes("/null/");
    return { run: n, finalUrl, nullRedirect, note: `start=${startUrl}` };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);
  const results: { run: number; finalUrl: string; nullRedirect: boolean; note: string }[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const r = await runOnce(t, n);
    results.push(r);
    console.log(`run ${n}: ${r.nullRedirect ? "NULL-REDIRECT" : "ok"} -> ${r.finalUrl}`);
  }
  const nullCount = results.filter((r) => r.nullRedirect).length;
  const report = {
    date: new Date().toISOString(),
    stage: "BUG-007 reproducibility series",
    runs: results,
    summary: { total: results.length, nullRedirects: nullCount },
  };
  const rep = await save(
    `bug007-series-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${nullCount}/5 прогонов с /null-редиректом; артефакт: ${rep}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
