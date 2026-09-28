// Этап 2.1: контрактные проверки каталога (Store API, только GET).
// База сравнения: докa Medusa v2 (list-products: count = total count of items).
// Запуск: npx tsx scripts/ts/api-contracts-catalog.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, apiGet, projectRoot } from "./lib/target.ts";

const artifactsDir = path.join(projectRoot, "reports", "artifacts");
async function save(name: string, text: string): Promise<string> {
  await mkdir(artifactsDir, { recursive: true });
  const file = path.join(artifactsDir, name);
  await writeFile(file, text, "utf8");
  return path.relative(projectRoot, file);
}

interface Line { check: string; pass: boolean | null; detail: string }
const lines: Line[] = [];
function rec(check: string, pass: boolean | null, detail: string): void {
  lines.push({ check, pass, detail });
  console.log(`[${pass === null ? "info" : pass ? "PASS" : "FAIL"}] ${check} — ${detail}`);
}

interface Prod { id: string; title: string; handle: string }
function parseProducts(body: string): { count: number; products: Prod[]; limit?: number; offset?: number } {
  return JSON.parse(body);
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  // --- A. Пагинация ---
  const page1 = await apiGet(t, "/store/products?limit=2&offset=0");
  const page2 = await apiGet(t, "/store/products?limit=2&offset=2");
  const over = await apiGet(t, "/store/products?limit=2&offset=10");
  const big = await apiGet(t, "/store/products?limit=100");
  await save("catalog-page1.json", page1.body);
  await save("catalog-page2.json", page2.body);
  await save("catalog-offset-over.json", over.body);

  const p1 = parseProducts(page1.body);
  const p2 = parseProducts(page2.body);
  const po = parseProducts(over.body);
  const pb = parseProducts(big.body);

  const ids1 = new Set(p1.products.map((p) => p.id));
  rec(
    "пагинация: offset=2 возвращает следующие записи (без пересечения)",
    p2.products.length > 0 && p2.products.every((p) => !ids1.has(p.id)),
    `страница1=[${p1.products.map((p) => p.handle).join(",")}] страница2=[${p2.products.map((p) => p.handle).join(",")}]`,
  );
  rec(
    "пагинация: offset за пределами -> пустой список",
    po.products.length === 0,
    `offset=10: products=${po.products.length}, count=${po.count} (BUG-001: count зеркалит страницу)`,
  );
  rec(
    "пагинация: limit=100 возвращает все записи с общим count",
    pb.products.length === pb.count && pb.count === 4,
    `products=${pb.products.length}, count=${pb.count}`,
  );

  // Граничные limit
  const l0 = await apiGet(t, "/store/products?limit=0");
  const lneg = await apiGet(t, "/store/products?limit=-1");
  await save("catalog-limit-0.json", l0.body);
  await save("catalog-limit-negative.json", lneg.body);
  rec("граница: limit=0 не падает сервером (4xx/пусто/умолчание)", null, `HTTP ${l0.status}, body: ${l0.body.slice(0, 120)}`);
  rec("граница: limit=-1 не падает сервером (4xx/пусто/умолчание)", null, `HTTP ${lneg.status}, body: ${lneg.body.slice(0, 120)}`);

  // --- B. Фильтры ---
  const TAG = "ptag_01M395CQH95VN9ZX361VS2JSC4"; // bug-demo-tag, только Sweatshirt
  const ftag = await apiGet(t, `/store/products?tag_id=${TAG}&limit=10`);
  await save("catalog-filter-tag.json", ftag.body);
  const ft = parseProducts(ftag.body);
  rec(
    "фильтр: tag_id=bug-demo-tag -> только Sweatshirt",
    ft.products.length === 1 && ft.products[0]?.handle === "sweatshirt",
    `[${ft.products.map((p) => p.handle).join(",")}]`,
  );

  const ftagNone = await apiGet(t, "/store/products?tag_id=ptag_nonexistent&limit=10");
  const ftn = parseProducts(ftagNone.body);
  rec(
    "фильтр: несуществующий tag_id -> 200 и пустой список",
    ftagNone.status === 200 && ftn.products.length === 0,
    `HTTP ${ftagNone.status}, products=${ftn.products.length}`,
  );

  const fq = await apiGet(t, "/store/products?q=shirt&limit=10");
  const fq2 = await apiGet(t, "/store/products?q=SWEATSHIRT&limit=10");
  await save("catalog-q-shirt.json", fq.body);
  const q = parseProducts(fq.body);
  const q2 = parseProducts(fq2.body);
  rec(
    "фильтр: q=shirt находит по title (T-Shirt и/или Sweatshirt)",
    q.products.some((p) => ["t-shirt", "sweatshirt"].includes(p.handle)),
    `[${q.products.map((p) => p.handle).join(",")}]`,
  );
  rec(
    "фильтр: q регистронезависим (SWEATSHIRT)",
    q2.products.some((p) => p.handle === "sweatshirt"),
    `[${q2.products.map((p) => p.handle).join(",")}]`,
  );

  const fcol = await apiGet(t, "/store/products?collection_id=nonexistent&limit=10");
  rec(
    "фильтр: несуществующий collection_id -> 200/пусто (не 500)",
    fcol.status === 200,
    `HTTP ${fcol.status}`,
  );

  // --- C. Сортировка ---
  const s1 = await apiGet(t, "/store/products?order=title&limit=10");
  const s2 = await apiGet(t, "/store/products?order=-created_at&limit=10");
  await save("catalog-order-title.json", s1.body);
  const st1 = parseProducts(s1.body);
  const titles = st1.products.map((p) => p.title);
  const sorted = [...titles].sort((a, b) => a.localeCompare(b));
  rec(
    "сортировка: order=title отдаёт алфавитный порядок",
    JSON.stringify(titles) === JSON.stringify(sorted),
    `[${titles.join(" | ")}]`,
  );
  rec("сортировка: order=-created_at принимается", s2.status === 200, `HTTP ${s2.status}`);

  // --- D. fields-проекция ---
  const f = await apiGet(t, "/store/products?limit=1&fields=id,title,handle");
  const fd = parseProducts(f.body);
  const extraKeys = fd.products[0] ? Object.keys(fd.products[0]).filter((k) => !["id", "title", "handle"].includes(k)) : [];
  rec(
    "fields: проекция id,title,handle не тянет лишние поля",
    f.status === 200 && extraKeys.length === 0,
    extraKeys.length === 0 ? "только запрошенные поля" : `лишние: [${extraKeys.join(",")}]`,
  );

  // --- Сводка ---
  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "2.1 catalog contracts",
    summary: { total: lines.length, failed: failed.length },
    lines,
  };
  const rep = await save(
    `stage2.1-catalog-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
