// Зонд §3.4: PDP не отдала кнопку «Select Options» в verify-ui-journeys (2 раза подряд).
// Фиксируем состояние страницы в момент таймаута: скриншот, кнопки, консоль, запросы.
// Запуск: npx tsx scripts/ts/probe-pdp-stall.ts
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
    const requests: string[] = [];
    page.on("console", (m) => consoleMsgs.push(`${m.type()}: ${m.text().slice(0, 200)}`));
    page.on("request", (r) => requests.push(r.url()));

    await page.goto(`${base}/dk/products/sweatshirt`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(15_000);

    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll("button")].map((b) => `${b.innerText.trim().slice(0, 40)}${b.disabled ? " [disabled]" : ""}`),
    );
    const bodyText = (await page.evaluate(() => document.body.innerText.slice(0, 500))).replace(/\n+/g, " | ");
    const shot = await page.screenshot();
    const report = {
      date: new Date().toISOString(),
      url: page.url(),
      title: await page.title(),
      buttons,
      bodyTextStart: bodyText,
      requests_127: requests.filter((u) => u.includes("127.0.0.1")),
      consoleMsgs: consoleMsgs.slice(0, 30),
      requestCount: requests.length,
    };
    const repPath = await save("probe-pdp-stall.json", JSON.stringify(report, null, 2));
    const shotPath = await save("probe-pdp-stall.png", shot);
    console.log(JSON.stringify(report, null, 2));
    console.log(`\nартефакты: ${repPath}, ${shotPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
