// Smoke-проверка Store API из TS-контура (npm run verify).
// Обход DNS-блокировки: IP берётся из .env / .cache/target-ip или через DoH,
// затем TCP-соединение идёт на этот IP при сохранении TLS SNI целевого хоста
// (аналог curl --resolve в config/targets.sh).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Agent, request } from "undici";

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

// Простой DoH-клиент (Cloudflare, application/dns-json), как в config/targets.sh
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
  const pubKey = env.PUBLISHABLE_KEY ?? process.env.PUBLISHABLE_KEY ?? "";
  if (!targetHost) throw new Error("TARGET_HOST не задан (.env)");

  // Пиннинг IP: .env -> кэш -> DoH
  let ip = env.TARGET_IP ?? "";
  const cachePath = path.join(projectRoot, ".cache", "target-ip");
  if (!ip && existsSync(cachePath)) ip = (await readFile(cachePath, "utf8")).trim();
  if (!ip) ip = await dohResolve(targetHost);

  const dispatcher = new Agent({
    connect: {
      // Кастомный lookup подменяет только TCP-адрес; SNI/проверка сертификата
      // остаются по целевому хосту. Node >= 20 вызывает lookup в двух режимах:
      // обычном (адрес + family) и Happy-Eyeballs (all: true -> массив адресов).
      lookup: (
        _hostname: string,
        opts: unknown,
        cb: (err: Error | null, addr: string | { address: string; family: number }[], family?: number) => void,
      ): void => {
        const all = (opts as { all?: boolean } | undefined)?.all === true;
        if (all) cb(null, [{ address: ip, family: 4 }]);
        else cb(null, ip, 4);
      },
    },
  });

  const url = `https://${targetHost}/store/products?limit=2`;
  const started = Date.now();
  const res = await request(url, {
    method: "GET",
    headers: { accept: "application/json", "x-publishable-api-key": pubKey },
    dispatcher,
  });
  const elapsed = Date.now() - started;
  const body = (await res.body.json()) as {
    products?: { title: string }[];
    count?: number;
  };
  if (res.statusCode !== 200) throw new Error(`HTTP ${res.statusCode} от ${url}`);

  const titles = (body.products ?? []).map((p) => p.title).join(", ");
  console.log(`[ok] HTTP ${res.statusCode} за ${elapsed} ms — count=${body.count}; products: ${titles}`);
  console.log(`[ok] IP ${ip} (pinned) -> ${targetHost}`);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(1);
});
