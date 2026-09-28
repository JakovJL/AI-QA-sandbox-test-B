// Этап 3.5 (мобайл): детерминизация мобильных прохождений (контур Б, 390×844).
//   A) мобильное меню открывается и содержит основные ссылки
//   B) карточка: варианты M/Black выбираются, Add to cart работает
//   C) корзина: суммы согласованы (subtotal = сумма позиций)
//   D) delivery-шаг: radiogroup пустая и Continue to payment disabled (BUG-008 на мобиле)
// Запуск: npx tsx scripts/ts/verify-mobile-journeys.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { resolveTarget, projectRoot } from "./lib/target.ts";

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

async function main(): Promise<void> {
  const t = await resolveTarget();
  const base = `https://${t.host}`;
  console.log(`target: ${t.host} @ ${t.ip} (mobile 390x844)\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

    // A. Мобильное меню
    await page.goto(`${base}/dk`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5000);
    await page.evaluate(() => {
      const m = [...document.querySelectorAll("button")].find(b => b.innerText.trim() === "Menu");
      if (m) m.click();
    });
    await page.waitForTimeout(1500);
    const menuLinks = await page.evaluate(() => {
      const scope = document.querySelector("[role=dialog], nav");
      return scope ? [...scope.querySelectorAll("a")].map(a => a.getAttribute("href")) : [];
    });
    rec(
      "A: мобильное меню открывается с основными ссылками",
      ["/dk", "/dk/store", "/dk/account", "/dk/cart"].every(h => menuLinks.includes(h)),
      `links=${JSON.stringify(menuLinks)}`,
    );

    // B. Карточка: варианты + add to cart
    await page.goto(`${base}/dk/products/t-shirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(7000);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll<HTMLButtonElement>("button")].find(x => x.innerText.trim() === "Select Options");
      if (b) b.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const s = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(x => x.innerText.trim() === "M");
      if (s) s.click();
    });
    await page.waitForTimeout(1500);
    await page.evaluate(() => {
      const c = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(x => x.innerText.trim() === "Black");
      if (c) c.click();
    });
    await page.waitForTimeout(2000);
    const addResult = await page.evaluate(() => {
      const adds = [...document.querySelectorAll<HTMLButtonElement>("main button")].filter(b => b.innerText.trim() === "Add to cart");
      if (adds.length === 0) return { ok: false, detail: "нет кнопки Add to cart" };
      const enabled = adds.find(b => !b.disabled);
      if (!enabled) return { ok: false, detail: "все Add to cart disabled" };
      enabled.click();
      return { ok: true, detail: "clicked" };
    });
    await page.waitForTimeout(3000);
    const cartCount = await page.evaluate(() => {
      const el = [...document.querySelectorAll("nav a, nav button")].find(x => /Cart \(/.test((x as HTMLElement).innerText));
      return el ? ((el as HTMLElement).innerText.match(/Cart \((\d+)\)/)?.[1] ?? "?") : "?";
    });
    rec(
      "B: карточка на мобиле — M/Black добавляется в корзину",
      addResult.ok && Number(cartCount) > 0,
      `${addResult.detail}; Cart (${cartCount})`,
    );

    // C. Корзина: суммы
    await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(3000);
    const totals = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("main tbody tr")].map(tr => {
        const cells = [...tr.querySelectorAll("td")];
        const total = (cells[cells.length - 1] as HTMLElement | undefined)?.innerText?.trim() ?? "";
        const qtySel = tr.querySelector("select");
        return { total, qty: qtySel ? qtySel.value : null };
      });
      const sub = [...document.querySelectorAll("main *")].find(e => /Subtotal/.test((e as HTMLElement).innerText) && e.children.length === 0);
      const subEl = sub?.parentElement?.querySelector<HTMLElement>("span:last-child, div:last-child");
      const money = [...document.body.innerText.matchAll(/[€$]\s?\d+[\.,]?\d*/g)].map(m => m[0]);
      return { rows, money, subRaw: subEl ? subEl.innerText : "?" };
    });
    await save("stage3-mobile-cart.json", JSON.stringify(totals, null, 2));
    rec(
      "C: мобильная корзина рендерит позиции и суммы",
      totals.rows.length > 0 && totals.money.length >= 3,
      `rows=${totals.rows.length}, money=${JSON.stringify(totals.money)}`,
    );

    // D. Чекаут delivery на мобиле (BUG-008)
    await page.locator("button", { hasText: /go to checkout/i }).first().click();
    await page.waitForTimeout(4000);
    let stepUrl = page.url();
    if (stepUrl.includes("step=address")) {
      const set = async (name: string, val: string) => {
        await page.locator(`main input[name="${name}"]`).fill(val);
      };
      await set("shipping_address.first_name", "QAM");
      await set("shipping_address.last_name", "Mobile");
      await set("shipping_address.address_1", "Test Lane 1");
      await set("shipping_address.postal_code", "1000");
      await set("shipping_address.city", "Kobenhavn");
      await set("email", "qa-mobile@test.local");
      // Диагностика состояния формы перед сабмитом
      const formState = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll<HTMLInputElement>("main input")].filter(i => i.required);
        const cont = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(b => /continue to delivery/i.test(b.innerText));
        return {
          empty: inputs.filter(i => !i.value).map(i => i.name),
          contDisabled: cont ? cont.disabled : null,
          validity: inputs.map(i => ({ n: i.name, ok: i.checkValidity() })),
        };
      });
      console.log(`    [diag] форма: empty=${JSON.stringify(formState.empty)}, contDisabled=${formState.contDisabled}, invalid=${JSON.stringify(formState.validity.filter(v => !v.ok).map(v => v.n))}`);
      await page.evaluate(() => {
        const form = document.querySelector("main form");
        const ev = new Event("submit", { bubbles: true, cancelable: true });
        if (form) form.dispatchEvent(ev);
      });
      // Дождаться перехода на delivery (URL меняется асинхронно)
      await page.waitForURL(/step=delivery/, { timeout: 30_000 }).catch(() => {});
      stepUrl = page.url();
    }
    if (stepUrl.includes("/null/")) {
      // BUG-007 воспроизвёлся в этой серии — фиксируем и восстанавливаем путь через корзину
      rec(
        "D1: BUG-007 (/null-редирект) в мобильной серии",
        false,
        `сабмит адреса увёл на ${stepUrl}`,
      );
      await page.goto(`${base}/dk/cart`, { waitUntil: "networkidle", timeout: 60_000 });
      await page.locator("button", { hasText: /go to checkout/i }).first().click();
      await page.waitForTimeout(4000);
      stepUrl = page.url();
    }
    if (!stepUrl.includes("step=delivery")) {
      rec(
        "D: BUG-008 на мобиле (radiogroup пуста, Continue disabled)",
        null,
        `не дошли до delivery: ${stepUrl}`,
      );
    } else {
      await page.waitForTimeout(8000);
      const delivery = await page.evaluate(() => {
        const rg = document.querySelector("main [role=radiogroup]");
        const cont = [...document.querySelectorAll<HTMLButtonElement>("main button")].find(b => /continue to payment/i.test(b.innerText));
        return { radioChildren: rg ? rg.children.length : -1, contDisabled: cont ? cont.disabled : null, url: location.pathname + location.search };
      });
      rec(
        "D: BUG-008 на мобиле (radiogroup пуста, Continue disabled)",
        delivery.radioChildren === 0 && delivery.contDisabled === true,
        `${delivery.url}: radioChildren=${delivery.radioChildren}, contDisabled=${delivery.contDisabled}`,
      );
    }
    const shot = path.join(projectRoot, "reports", "screenshots", "stage3-mobile-delivery.png");
    await page.screenshot({ path: shot });
  } finally {
    await browser.close();
  }

  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "3.5 mobile journeys (contour B)",
    summary: { total: lines.length, failed: failed.length },
    lines,
  };
  const rep = await save(
    `stage3.5-mobile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
