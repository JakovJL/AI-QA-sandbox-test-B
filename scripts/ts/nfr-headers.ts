// Этап 4.1: заголовки безопасности (NFR). Матрица по поверхностям:
//   /dk (SSR витрина), /dk/store, /app (админ SPA), /store/products (API), /auth/session (auth)
// Проверки: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
//           Permissions-Policy, x-powered-by, флаги куки, SEO-эндпоинты (robots/sitemap).
// Запуск: npx tsx scripts/ts/nfr-headers.ts
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

const SECURITY_HEADERS = [
  "content-security-policy",
  "strict-transport-security",
  "x-frame-options",
  "x-content-type-options",
  "referrer-policy",
  "permissions-policy",
] as const;

function lower(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  const surfaces = [
    { name: "витрина /dk", path: "/dk" },
    { name: "каталог /dk/store", path: "/dk/store" },
    { name: "админка /app", path: "/app" },
    { name: "API /store/products", path: "/store/products?limit=1" },
  ];

  const matrix: Record<string, Record<string, string | null>> = {};
  for (const s of surfaces) {
    const r = await apiGet(t, s.path, s.path.startsWith("/store") ? {} : { accept: "text/html" });
    const h = lower(r.headers);
    const row: Record<string, string | null> = {};
    for (const key of SECURITY_HEADERS) {
      row[key] = h[key] ?? null;
    }
    row["x-powered-by"] = h["x-powered-by"] ?? null;
    matrix[s.name] = row;
    await save(`nfr-headers-${s.path.replace(/[^a-z0-9]/gi, "_")}.json`, r.body ? JSON.stringify({ headers: r.headers }, null, 2) : "empty");
  }

  // Сводка по матрице
  for (const key of SECURITY_HEADERS) {
    const present = surfaces.filter(s => (matrix[s.name]?.[key] ?? null) !== null);
    rec(
      `заголовок ${key}`,
      present.length === surfaces.length,
      present.length === 0 ? "отсутствует на всех поверхностях" : `есть на: ${present.map(p => p.name).join(", ")}`,
    );
  }
  const powered = surfaces.filter(s => (matrix[s.name]?.["x-powered-by"] ?? null) !== null);
  rec(
    "x-powered-by раскрывает стек",
    powered.length === 0,
    powered.map(p => `${p.name}: ${matrix[p.name]?.["x-powered-by"] ?? "?"}`).join("; ") || "не раскрыт",
  );

  // Куки-флаги (из ответа /dk)
  const dk = await apiGet(t, "/dk", { accept: "text/html" });
  const setCookie = lower(dk.headers)["set-cookie"] ?? "";
  const hasHttpOnly = /httponly/i.test(setCookie);
  const hasSecure = /secure/i.test(setCookie);
  const hasSameSite = /samesite/i.test(setCookie);
  const cookieName = setCookie.split("=")[0];
  rec(
    `куки ${cookieName}: HttpOnly/Secure/SameSite`,
    hasHttpOnly && hasSecure && hasSameSite,
    `HttpOnly=${hasHttpOnly}, Secure=${hasSecure}, SameSite=${hasSameSite}`,
  );

  // SEO-эндпоинты: robots.txt / sitemap.xml должны быть текстом, не HTML-200
  for (const seo of ["/robots.txt", "/sitemap.xml"]) {
    const r = await apiGet(t, seo);
    const ct = lower(r.headers)["content-type"] ?? "";
    const isHtml = ct.includes("text/html");
    rec(
      `SEO ${seo}: content-type (${isHtml ? "HTML вместо текста!" : ct})`,
      !isHtml,
      `HTTP ${r.status}, ${ct}, bytes=${r.body.length}`,
    );
    await save(`nfr-seo-${seo.replace(/\W/g, "_")}.json`, JSON.stringify({ status: r.status, contentType: ct, bytes: r.body.length, head: r.body.slice(0, 200) }, null, 2));
  }

  // OG/Twitter мета на 127.0.0.1 (прод-артефакты localhost)
  const dkHtml = (await apiGet(t, "/dk", { accept: "text/html" })).body;
  const ogMatches = [...dkHtml.matchAll(/(og:image|twitter:image)" content="([^"]{0,80})"/g)].map(m => `${m[1]}=${m[2]}`);
  const localhostMeta = ogMatches.filter(m => m.includes("127.0.0.1"));
  rec(
    "og:image/twitter:image указывают на localhost",
    ogMatches.length > 0 && localhostMeta.length === ogMatches.length,
    `${localhostMeta.length}/${ogMatches.length} localhost: ${localhostMeta[0] ?? "—"}`,
  );

  // 404-рендер: код страницы 404
  const nf = await apiGet(t, "/dk/nonexistent-page-qa", { accept: "text/html" });
  const nfIsHtml = (lower(nf.headers)["content-type"] ?? "").includes("text/html");
  rec(
    "404-рендер несуществующей страницы отдаёт HTTP 404",
    nf.status === 404,
    `HTTP ${nf.status}, html=${nfIsHtml}`,
  );

  // --- Сводка ---
  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "4.1 headers + 4.2 SEO",
    summary: { total: lines.length, failed: failed.length },
    lines,
    matrix,
  };
  const rep = await save(
    `stage4.1-headers-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
