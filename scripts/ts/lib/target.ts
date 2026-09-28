// Общий доступ к цели из TS-контура: .env -> .cache/target-ip -> DoH,
// затем TCP на pinned IP при сохранении TLS SNI (аналог curl --resolve).
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Agent, request } from "undici";

export const projectRoot = path.resolve(import.meta.dirname, "../../..");

export type Env = Record<string, string>;

export async function loadEnv(): Promise<Env> {
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

export async function dohResolve(host: string): Promise<string> {
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

export interface Target {
  host: string;
  ip: string;
  pubKey: string;
  dispatcher: Agent;
}

export async function resolveTarget(): Promise<Target> {
  const env = await loadEnv();
  const host = env.TARGET_HOST ?? process.env.TARGET_HOST;
  const pubKey = env.PUBLISHABLE_KEY ?? process.env.PUBLISHABLE_KEY ?? "";
  if (!host) throw new Error("TARGET_HOST не задан (.env)");

  let ip = env.TARGET_IP ?? "";
  const cachePath = path.join(projectRoot, ".cache", "target-ip");
  if (!ip && existsSync(cachePath)) ip = (await readFile(cachePath, "utf8")).trim();
  if (!ip) ip = await dohResolve(host);

  const dispatcher = new Agent({
    connect: {
      // Подменяем только TCP-адрес; SNI/сертификат остаются по целевому хосту.
      // Node >= 20 вызывает lookup в двух режимах (обычный и Happy-Eyeballs all:true).
      lookup: (
        _hostname: string,
        opts: unknown,
        cb: (
          err: Error | null,
          addr: string | { address: string; family: number }[],
          family?: number,
        ) => void,
      ): void => {
        const all = (opts as { all?: boolean } | undefined)?.all === true;
        if (all) cb(null, [{ address: ip, family: 4 }]);
        else cb(null, ip, 4);
      },
    },
  });
  return { host, ip, pubKey, dispatcher };
}

export interface ApiResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  elapsedMs: number;
  url: string;
}

export async function apiGet(
  t: Target,
  path: string,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const url = `https://${t.host}${path}`;
  const started = Date.now();
  const res = await request(url, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-publishable-api-key": t.pubKey,
      ...headers,
    },
    dispatcher: t.dispatcher,
  });
  const body = await res.body.text();
  return {
    status: res.statusCode,
    headers: Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
    ),
    body,
    elapsedMs: Date.now() - started,
    url,
  };
}

export async function apiPost(
  t: Target,
  path: string,
  jsonBody: unknown,
  headers: Record<string, string> = {},
): Promise<ApiResult> {
  const url = `https://${t.host}${path}`;
  const started = Date.now();
  const res = await request(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-publishable-api-key": t.pubKey,
      ...headers,
    },
    body: JSON.stringify(jsonBody),
    dispatcher: t.dispatcher,
  });
  const body = await res.body.text();
  return {
    status: res.statusCode,
    headers: Object.fromEntries(
      Object.entries(res.headers).map(([k, v]) => [k, String(v)]),
    ),
    body,
    elapsedMs: Date.now() - started,
    url,
  };
}
