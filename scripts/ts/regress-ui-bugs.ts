// Регрессия 2026-09-29: UI-дефекты BUG-007 (транзиент, §3.4) и BUG-008 (delivery) под ТЕКУЩИЙ флоу витрины.
// NB: с 28.09 PDP изменилась — варианты инлайн (L/M/S/XL), «Select Options»-модалки нет (см. probe-pdp-stall.json).
// Серия: 5 десктоп (1440x1000) + 3 мобайл (390x844) прогонов «корзина → чекаут → адрес → delivery».
// Запуск: npx tsx scripts/ts/regress-ui-bugs.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolveTarget, projectRoot, type Target } from "./lib/target.ts";

const artifacts = path.join(projectRoot, "reports", "artifacts", "regress-2909");
async function save(name: string, data: string | Buffer): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  const file = path.join(artifacts, name);
  await writeFile(file, data);
  return path.relative(projectRoot, file);
}

interface RunResult {
  run: string;
  finalUrl: string;
  nullRedirect: boolean;
  radiogroupOptions: number;
  continueDisabled: boolean | null;
  deliveryNote: string;
}

async function runOnce(t: Target, label: string, mobile: boolean): Promise<RunResult> {
  const base = `https://${t.host}`;
  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  const result: RunResult = {
    run: label,
    finalUrl: "",
    nullRedirect: false,
    radiogroupOptions: -1,
    continueDisabled: null,
    deliveryNote: "",
  };
  try {
    const page = await browser.newPage({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    });

    // 1. PDP: выбор размера инлайн + Add to cart (новый флоу без «Select Options»)
    const pdp = mobile ? `${base}/dk/products/t-shirt` : `${base}/dk/products/sweatshirt`;
    await page.goto(pdp, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(8_000);
    await page.evaluate(() => {
      const sizes = ["S", "M", "L", "XL"];
      for (const s of sizes) {
        const b = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
          (x) => x.innerText.trim() === s && !x.disabled,
        );
        if (b) {
          b.click();
          return;
        }
      }
    });
    await page.waitForTimeout(1_500);
    await page.evaluate(() => {
      const add = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(
        (x) => x.innerText.trim() === "Add to cart" && !x.disabled,
      );
      if (add) add.click();
    });
    await page.waitForTimeout(3_000);

    // 2. Корзина → чекаут
    await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    await page.evaluate(() => {
      const go = [...document.querySelectorAll<HTMLButtonElement>("main button, a")].find((b) =>
        /go to checkout/i.test(b.innerText),
      );
      if (go) (go as HTMLButtonElement).click();
    });
    await page.waitForTimeout(3_000);
    if (page.url().includes("step=delivery")) {
      // Адрес уже в корзине — delivery сразу; BUG-007 в этом прогоне не проверялся
      const rg = await page.evaluate(() => document.querySelector('[role="radiogroup"]')?.children.length ?? -1);
      result.finalUrl = page.url();
      result.nullRedirect = false;
      result.radiogroupOptions = rg;
      result.deliveryNote = "delivery сразу (адрес из корзины), address-сабмит пропущен";
      return result;
    }

    // 3. Форма адреса (name-атрибуты прежние; NB: форма/кнопки вне <main> — скоп весь документ,
    // см. probe-checkout-address.json)
    const set = async (name: string, val: string) => {
      await page.locator(`input[name="${name}"]`).fill(val);
    };
    await set("shipping_address.first_name", "QA");
    await set("shipping_address.last_name", "Regress");
    await set("shipping_address.address_1", "Test Lane 1");
    await set("shipping_address.postal_code", "1000");
    await set("shipping_address.city", "Kobenhavn");
    await set("email", "qa-regress@test.local");

    // 4. Сабмит → фиксация URL (BUG-007: /null/checkout)
    await page.evaluate(() => {
      const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /continue to delivery/i.test(b.innerText),
      );
      if (cont) cont.click();
    });
    await page.waitForTimeout(5_000);
    result.finalUrl = page.url();
    result.nullRedirect = result.finalUrl.includes("/null/");

    // 5. Если всё же ушли в /null — BUG-007 пойман; иначе проверяем delivery (BUG-008)
    if (result.nullRedirect) {
      await save(`bug007-caught-${label}.png`, await page.screenshot());
      result.deliveryNote = "NULL-REDIRECT пойман, скриншот сохранён";
      return result;
    }

    // 6. Delivery: radiogroup и кнопка Continue to payment (BUG-008)
    await page.waitForTimeout(8_000);
    const delivery = await page.evaluate(() => {
      const rg = document.querySelector('[role="radiogroup"]');
      const kids = rg ? rg.children.length : -1;
      const cont = [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
        /continue to payment/i.test(b.innerText),
      );
      return { kids, disabled: cont ? cont.disabled : null, url: location.href };
    });
    result.radiogroupOptions = delivery.kids;
    result.continueDisabled = delivery.disabled;
    result.finalUrl = delivery.url;
    result.deliveryNote = "delivery после сабмита адреса";
    return result;
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);
  const runs: RunResult[] = [];
  for (const n of [1, 2, 3, 4, 5]) {
    const r = await runOnce(t, `desktop-${n}`, false);
    runs.push(r);
    console.log(`${r.run}: ${r.nullRedirect ? "NULL-REDIRECT" : "ok"} -> ${r.finalUrl} | radiogroup=${r.radiogroupOptions}, continueDisabled=${r.continueDisabled}`);
  }
  for (const n of [1, 2, 3]) {
    const r = await runOnce(t, `mobile-${n}`, true);
    runs.push(r);
    console.log(`${r.run}: ${r.nullRedirect ? "NULL-REDIRECT" : "ok"} -> ${r.finalUrl} | radiogroup=${r.radiogroupOptions}, continueDisabled=${r.continueDisabled}`);
  }

  const nullCount = runs.filter((r) => r.nullRedirect).length;
  const emptyRg = runs.filter((r) => !r.nullRedirect && r.radiogroupOptions === 0);
  const report = {
    date: new Date().toISOString(),
    target: { host: t.host, ip: t.ip },
    kind: "regression-ui-bugs (текущий флоу: инлайн-варианты, без Select Options)",
    runs,
    summary: {
      total: runs.length,
      nullRedirects: nullCount,
      emptyRadiogroup: emptyRg.length,
      deliveryChecked: runs.filter((r) => r.radiogroupOptions >= 0 && !r.nullRedirect).length,
    },
  };
  const rep = await save("regress-ui-summary.json", JSON.stringify(report, null, 2));
  console.log(
    `\nитог: /null-редиректов ${nullCount}/${runs.length}; пустая radiogroup ${emptyRg.length} из ${runs.filter((r) => !r.nullRedirect).length} delivery-проверок; артефакт: ${rep}`,
  );
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
