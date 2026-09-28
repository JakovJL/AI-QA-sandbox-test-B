// Smoke-проверка контура Б: изолированный Playwright + chromium.
// Обход DNS-блокировки без админ-прав: --host-resolver-rules мапит целевой
// хост на реальный IP (см. docs/00-environment.md). IP — как в smoke-store.ts:
// .env -> .cache/target-ip -> DoH.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { request } from "undici";

const projectRoot = path.resolve(import.meta.dirname, "../..");

type Env = Record<string, string>;

async function loadEnv(): Promise<Env> {
  const envPath = path.join(projectRoot, ".env");
  const env: Env = {};
  if (!existsSync(envPath)) return env;
  const raw = await readFile(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
}

async function dohResolve(host: string): Promise<string> {
  const res = await request(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    { headers: { accept: "application/dns-json" } },
  );
  const body = (await res.body.json()) as {
    Answer?: { type: number; data: string }[];
  };
  const a = (body.Answer ?? []).find((x) => x.type === 1);
  if (!a) throw new Error(`DoH: нет A-записи для ${host}`);
  return a.data;
}

async function main(): Promise<void> {
  const env = await loadEnv();
  const targetHost = env.TARGET_HOST ?? process.env.TARGET_HOST;
  if (!targetHost) throw new Error("TARGET_HOST не задан (.env)");

  let ip = env.TARGET_IP ?? "";
  const cachePath = path.join(projectRoot, ".cache", "target-ip");
  if (!ip && existsSync(cachePath)) ip = (await readFile(cachePath, "utf8")).trim();
  if (!ip) ip = await dohResolve(targetHost);

  const browser = await chromium.launch({
    headless: true,
    args: [`--host-resolver-rules=MAP ${targetHost} ${ip}`],
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    const started = Date.now();
    const resp = await page.goto(`https://${targetHost}/dk`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const elapsed = Date.now() - started;
    const title = await page.title();
    console.log(`[ok] HTTP ${resp?.status()} за ${elapsed} ms — title: "${title}"`);
    console.log(`[ok] chromium ${browser.version()}, IP ${ip} (host-resolver-rules)`);
    if (errors.length > 0) console.log(`[warn] pageerror: ${errors.slice(0, 3).join(" | ")}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(1);
});
