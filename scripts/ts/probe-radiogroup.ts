// Финальный зонд чекаута: что в radiogroup на address-шаге (подсказка о BUG-008 в новой сборке),
// кликабельна ли опция доставки, есть ли запросы на 127.0.0.1 и ошибки консоли.
// Запуск: npx tsx scripts/ts/probe-radiogroup.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolveTarget, projectRoot } from "./lib/target.ts";

const dir = path.join(projectRoot, "reports", "artifacts", "regress-2909");
async function save(name: string, data: string | Buffer): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, data);
  return path.relative(projectRoot, file);
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  const base = `https://${t.host}`;
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const consoleMsgs: string[] = [];
    const req127: string[] = [];
    page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 150)}`));
    page.on("request", (r) => {
      if (r.url().includes("127.0.0.1")) req127.push(r.url());
    });

    await page.goto(`${base}/dk/products/sweatshirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
        (x) => ["S", "M", "L", "XL"].includes(x.innerText.trim()) && !x.disabled,
      );
      if (b) b.click();
    });
    await page.waitForTimeout(1_500);
    await page.evaluate(() => {
      const add = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
        (x) => x.innerText.trim() === "Add to cart" && !x.disabled,
      );
      if (add) add.click();
    });
    await page.waitForTimeout(3_000);
    await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      const go = [...document.querySelectorAll<HTMLButtonElement | HTMLAnchorElement>("main button, main a")].find((b) =>
        /go to checkout/i.test(b.innerText ?? ""),
      );
      if (go) (go as HTMLButtonElement).click();
    });
    await page.waitForTimeout(6_000);

    const rg = await page.evaluate(() => {
      const el = document.querySelector('[role="radiogroup"]');
      if (!el) return { found: false };
      const radio = el.querySelector('[role="radio"]');
      const label = el.textContent?.trim().slice(0, 200) ?? "";
      if (radio) (radio as HTMLElement).click();
      return { found: true, label, clickedRadio: !!radio };
    });
    await page.waitForTimeout(1_500);
    const afterClick = await page.evaluate(() => ({
      radioCount: document.querySelectorAll('[role="radio"]').length,
      ariaChecked: [...document.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute("aria-checked")),
    }));

    const report = {
      date: new Date().toISOString(),
      url: page.url(),
      radiogroup: rg,
      afterClick,
      req127,
      consoleMsgs: consoleMsgs.slice(0, 25),
    };
    const rep = await save("probe-radiogroup.json", JSON.stringify(report, null, 2));
    await save("probe-radiogroup.png", await page.screenshot());
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nартефакт: ${rep}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
