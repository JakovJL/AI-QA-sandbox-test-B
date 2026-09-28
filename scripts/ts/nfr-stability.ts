// Этап 4.4: стабильность/перф (аккуратные лимиты: ≤30 req/мин суммарно по цели).
// 3 раунда × 10 запросов GET /store/products (итого 30 запросов, ~2.5 мин при задержках).
// Замер p50/p95, фиксация нестатусных ответов (307/5xx), межраундные паузы 40 c.
// Запуск: npx tsx scripts/ts/nfr-stability.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, apiGet, projectRoot } from "./lib/target.ts";

const artifacts = path.join(projectRoot, "reports", "artifacts");
async function save(name: string, text: string): Promise<string> {
  await mkdir(artifacts, { recursive: true });
  const file = path.join(artifacts, name);
  await writeFile(file, text, "utf8");
  return path.relative(projectRoot, file);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  const rounds: { round: number; times: number[]; statuses: Record<number, number> }[] = [];
  const anomalies: { round: number; i: number; status: number; time: number }[] = [];

  for (const round of [1, 2, 3]) {
    const times: number[] = [];
    const statuses: Record<number, number> = {};
    for (let i = 0; i < 10; i++) {
      const r = await apiGet(t, "/store/products?limit=4");
      times.push(r.elapsedMs);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
      if (r.status !== 200) anomalies.push({ round, i, status: r.status, time: r.elapsedMs });
      await sleep(2500); // ~24 req/мин темп
    }
    rounds.push({ round, times, statuses });
    const sorted = [...times].sort((a, b) => a - b);
    console.log(`round ${round}: statuses=${JSON.stringify(statuses)}, p50=${percentile(sorted, 50).toFixed(0)}ms, p95=${percentile(sorted, 95).toFixed(0)}ms`);
    if (round < 3) {
      console.log("  пауза 40 c...");
      await sleep(40_000);
    }
  }

  const allTimes = rounds.flatMap(r => r.times).sort((a, b) => a - b);
  const allStatus200 = rounds.reduce((s, r) => s + (r.statuses[200] ?? 0), 0);
  const summary = {
    date: new Date().toISOString(),
    requests: allTimes.length,
    status200: allStatus200,
    anomalies,
    p50: percentile(allTimes, 50),
    p95: percentile(allTimes, 95),
    min: allTimes[0],
    max: allTimes[allTimes.length - 1] ?? 0,
  };
  console.log(`\nитог: ${summary.status200}/${summary.requests} → 200; p50=${summary.p50}ms, p95=${summary.p95}ms, min/max=${summary.min}/${summary.max}ms; аномалий: ${anomalies.length}`);

  const rep = await save(
    `stage4.4-stability-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify({ date: new Date().toISOString(), rounds, summary }, null, 2),
  );
  console.log(`артефакт: ${rep}`);
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
