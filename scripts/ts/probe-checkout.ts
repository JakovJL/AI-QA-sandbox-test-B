// Зонд: фактическая структура /dk/checkout?step=address (инпуты, кнопки) — под новый UI витрины.
// Запуск: npx tsx scripts/ts/probe-checkout.ts
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
    // Корзина с товаром: PDP инлайн-вариант -> add to cart
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

    // Пробуем полный сабмит: заполнить форму, нажать Continue to delivery, снять ошибки/URL.
    const apiCalls: { url: string; status: number; method: string }[] = [];
    page.on("response", (r) => {
      const u = r.url();
      if (u.includes("/store/") || u.includes("checkout")) apiCalls.push({ url: u.slice(0, 120), status: r.status(), method: r.request().method() });
    });
    const fillName = async (name: string, val: string) => {
      await page.locator(`input[name="${name}"]`).fill(val);
    };
    await fillName("shipping_address.first_name", "QA");
    await fillName("shipping_address.last_name", "Probe");
    await fillName("shipping_address.address_1", "Test Lane 1");
    await fillName("shipping_address.postal_code", "1000");
    await fillName("shipping_address.city", "Kobenhavn");
    await fillName("email", "qa-probe@test.local");
    await fillName("shipping_address.phone", "+4512345678");
    // required-атрибуты полей (нативная валидация?)
    const requireds = await page.evaluate(() =>
      [...document.querySelectorAll("input, select")].map((i) => `${i.getAttribute("name")}:required=${(i as HTMLInputElement).required}`),
    );
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /continue to delivery/i.test(b.innerText),
      );
      if (cont) cont.click();
    });
    await page.waitForTimeout(6_000);
    const afterSubmit = await page.evaluate(() => ({
      url: location.href,
      errors: [...document.querySelectorAll("main p, main span, main div")]
        .map((e) => e.textContent?.trim() ?? "")
        .filter((x) => /required|invalid|error|obligat/i.test(x))
        .slice(0, 10),
      buttons: [...document.querySelectorAll("button")].map((b) => `${b.innerText.trim().slice(0, 40)}${b.disabled ? " [disabled]" : ""}`),
    }));
    // Попытка 2: Enter в поле email + requestSubmit()
    await page.locator("input[name=email]").press("Enter");
    await page.waitForTimeout(4_000);
    const afterEnter = await page.evaluate(() => location.href);
    await page.evaluate(() => {
      const f = document.querySelector("form");
      if (f) (f as HTMLFormElement).requestSubmit();
    });
    await page.waitForTimeout(4_000);
    const afterRequestSubmit = await page.evaluate(() => location.href);
    const report2 = { afterSubmit, afterEnter, afterRequestSubmit, apiCalls: apiCalls.slice(-25), requireds };
    await save("probe-checkout-after-submit.json", JSON.stringify(report2, null, 2));
    await save("probe-checkout-after-submit.png", await page.screenshot());
    console.log("report2:", JSON.stringify(report2, null, 2));

    // Попытка 4: НАСТОЯЩИЙ клик Playwright (actionability) + полная запись сети 15 c.
    apiCalls.length = 0;
    page.on("response", (r) => apiCalls.push({ url: r.url().slice(0, 120), status: r.status(), method: r.request().method() }));
    const realBtn = page.locator('button:has-text("Continue to delivery")').first();
    const box = await realBtn.boundingBox();
    await realBtn.click({ timeout: 10_000 });
    await page.waitForTimeout(15_000);
    const afterRealClick = { url: page.url(), box, apiCalls: apiCalls.slice(-30) };
    await save("probe-checkout-real-click.json", JSON.stringify(afterRealClick, null, 2));
    await save("probe-checkout-real-click.png", await page.screenshot());
    console.log("realClick:", JSON.stringify(afterRealClick, null, 2));

    const inputs = await page.evaluate(() =>
      [...document.querySelectorAll("input, select, textarea")].map((i) => ({
        tag: i.tagName,
        name: i.getAttribute("name"),
        type: i.getAttribute("type"),
        visible: !!(i as HTMLElement).offsetParent,
      })),
    );
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => ({
        text: b.innerText.trim().slice(0, 50),
        disabled: b.disabled,
      })),
    );
    const radiogroups = await page.evaluate(() =>
      [...document.querySelectorAll('[role="radiogroup"]')].map((rg) => ({
        children: rg.children.length,
        html: rg.innerHTML.slice(0, 200),
      })),
    );
    const report = { date: new Date().toISOString(), url: page.url(), inputs, buttons, radiogroups };
    const repPath = await save("probe-checkout-address.json", JSON.stringify(report, null, 2));
    await save("probe-checkout-address.png", await page.screenshot());
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nартефакт: ${repPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
