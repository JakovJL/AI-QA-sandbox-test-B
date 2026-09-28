// Этап 4.3: доступность (axe-core) в контуре Б, headless chromium.
// Страницы: /dk, /dk/store, /dk/products/sweatshirt, /dk/cart, /dk/checkout (address).
// Запуск: npx tsx scripts/ts/nfr-axe.ts
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

interface Violation { id: string; impact: string | null; nodes: number; help: string }
interface PageResult { page: string; url: string; violations: Violation[]; passes: number }

const AXE_SOURCE = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js";

async function scan(page: import("playwright").Page, url: string, name: string): Promise<PageResult> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForTimeout(6000); // гидрация
  await page.addScriptTag({ url: AXE_SOURCE });
  const result = (await page.evaluate(() => {
    const axe = (window as unknown as { axe?: { run: () => Promise<{ violations: { id: string; impact: string | null; nodes: unknown[]; help: string }[]; passes: unknown[] }> } }).axe;
    if (!axe) return null;
    return axe.run();
  })) as { violations: { id: string; impact: string | null; nodes: unknown[]; help: string }[]; passes: unknown[] } | null;
  if (!result) return { page: name, url, violations: [{ id: "axe-not-loaded", impact: null, nodes: 1, help: "axe не загрузился" }], passes: 0 };
  const violations: Violation[] = result.violations
    .map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, help: v.help }))
    .sort((a, b) => {
      const order: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return (order[a.impact ?? "minor"] ?? 4) - (order[b.impact ?? "minor"] ?? 4);
    });
  return { page: name, url, violations, passes: result.passes.length };
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  const base = `https://${t.host}`;
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${t.host} ${t.ip}`],
  });
  const results: PageResult[] = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    results.push(await scan(page, `${base}/dk`, "главная"));
    results.push(await scan(page, `${base}/dk/store`, "каталог"));
    results.push(await scan(page, `${base}/dk/products/sweatshirt`, "карточка"));
    results.push(await scan(page, `${base}/dk/cart`, "корзина"));
    results.push(await scan(page, `${base}/dk/checkout?step=address`, "чекаут-address"));
  } finally {
    await browser.close();
  }

  for (const r of results) {
    const crit = r.violations.filter(v => v.impact === "critical").length;
    const ser = r.violations.filter(v => v.impact === "serious").length;
    const top = r.violations.slice(0, 3).map(v => `${v.id}(${v.impact}, ${v.nodes})`).join(", ");
    console.log(`${r.page}: critical=${crit} serious=${ser} total=${r.violations.length} | ${top || "чисто"}`);
  }

  const totalCritical = results.reduce((s, r) => s + r.violations.filter(v => v.impact === "critical").length, 0);
  const totalSerious = results.reduce((s, r) => s + r.violations.filter(v => v.impact === "serious").length, 0);
  console.log(`\nсуммарно: critical=${totalCritical}, serious=${totalSerious}`);

  const rep = await save(
    `stage4.3-axe-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify({ date: new Date().toISOString(), results, totalCritical, totalSerious }, null, 2),
  );
  console.log(`артефакт: ${rep}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
