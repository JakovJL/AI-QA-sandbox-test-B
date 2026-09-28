// Этап 2.2: негативные и граничные проверки корзины (Store API).
// Создаваемые корзины маркируются metadata { qa: true }; деструктивных действий нет.
// Запуск: npx tsx scripts/ts/api-negative-cart.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveTarget, apiGet, apiPost, projectRoot, type ApiResult } from "./lib/target.ts";

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

function shortBody(r: ApiResult, n = 140): string {
  return r.body.replace(/\s+/g, " ").slice(0, n);
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  // Тестовый вариант (Sweatshirt S) из стадии 2.1
  const prod = await apiGet(t, "/store/products?limit=1");
  const variantId = (JSON.parse(prod.body) as {
    products: { variants: { id: string }[] }[];
  }).products[0]!.variants[0]!.id;

  // --- 0. Отсутствующий/битый publishable key ---
  const noKey = await apiGet(t, "/store/products?limit=1", { "x-publishable-api-key": "" });
  rec(
    "ключ: пустой publishable key отклоняется (400/401)",
    [400, 401, 403].includes(noKey.status),
    `HTTP ${noKey.status}`,
  );
  const badKey = await apiGet(t, "/store/products?limit=1", { "x-publishable-api-key": "pk_invalid_qa" });
  rec(
    "ключ: невалидный publishable key отклоняется (400/401)",
    [400, 401, 403].includes(badKey.status),
    `HTTP ${badKey.status}, ${shortBody(badKey, 80)}`,
  );

  // --- 1. Маркированная корзина (qa:true) ---
  const cartResp = await apiPost(t, "/store/carts", { metadata: { qa: true } });
  const cartId = (JSON.parse(cartResp.body) as { cart: { id: string } }).cart.id;
  await save(`cart-${cartId}-create.json`, cartResp.body);
  rec("корзина: создаётся с metadata qa=true", cartResp.status === 200, `HTTP ${cartResp.status}, id=${cartId}`);

  // --- 2. Негативные добавления ---
  const badVariant = await apiPost(t, `/store/carts/${cartId}/line-items`, {
    variant_id: "variant_nonexistent",
    quantity: 1,
  });
  await save("cart-add-bad-variant.json", badVariant.body);
  rec(
    "корзина: несуществующий variant_id -> 400 (не 500)",
    badVariant.status === 400,
    `HTTP ${badVariant.status}, ${shortBody(badVariant)}`,
  );

  const q0 = await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: 0 });
  await save("cart-add-quantity-0.json", q0.body);
  rec("корзина: quantity=0 -> 400 (не 500)", q0.status === 400, `HTTP ${q0.status}, ${shortBody(q0)}`);

  const qneg = await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: -3 });
  await save("cart-add-quantity-negative.json", qneg.body);
  rec(
    "корзина: quantity=-3 -> 400 (не создаёт отрицательную позицию)",
    qneg.status === 400,
    `HTTP ${qneg.status}, ${shortBody(qneg)}`,
  );

  const qbig = await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: 1000000 });
  await save("cart-add-quantity-1e6.json", qbig.body);
  rec(
    "корзина: quantity=1e6 -> 400/инвентарная ошибка (не молчаливое создание)",
    [400, 422].includes(qbig.status) || qbig.body.includes("inventory"),
    `HTTP ${qbig.status}, ${shortBody(qbig)}`,
  );

  const noVar = await apiPost(t, `/store/carts/${cartId}/line-items`, { quantity: 1 });
  rec(
    "корзина: без variant_id -> 400",
    noVar.status === 400,
    `HTTP ${noVar.status}, ${shortBody(noVar)}`,
  );

  // --- 3. Базовое добавление (валидное) для последующих проверок ---
  const addOk = await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: 1 });
  await save(`cart-${cartId}-add-ok.json`, addOk.body);
  const added = JSON.parse(addOk.body) as { cart: { items: { id: string; quantity: number }[] } };
  const lineItem = added.cart.items[0];
  rec("корзина: валидное добавление -> item появляется", addOk.status === 200 && !!lineItem, `HTTP ${addOk.status}, items=${added.cart.items.length}`);

  // --- 4. Чужие/несуществующие корзины ---
  const ghost = await apiPost(t, "/store/carts/cart_nonexistent/line-items", { variant_id: variantId, quantity: 1 });
  await save("cart-ghost-add.json", ghost.body);
  rec(
    "корзина: несуществующая корзина -> 404 (не 200/500)",
    ghost.status === 404,
    `HTTP ${ghost.status}, ${shortBody(ghost)}`,
  );

  const ghostGet = await apiGet(t, "/store/carts/cart_nonexistent");
  rec("корзина: GET несуществующей -> 404", ghostGet.status === 404, `HTTP ${ghostGet.status}`);

  // id соседней корзины того же прогона как «чужой» (изолированность сессий)
  const cart2 = await apiPost(t, "/store/carts", { metadata: { qa: true } });
  const cart2Id = (JSON.parse(cart2.body) as { cart: { id: string } }).cart.id;
  const lineId = lineItem?.id ?? "li_nonexistent";
  const foreignUpdate = await apiPost(t, `/store/carts/${cart2Id}/line-items/${lineId}`, {
    quantity: 5,
  });
  await save("cart-foreign-lineitem-update.json", foreignUpdate.body);
  rec(
    "корзина: обновление чужого line-item -> 404 (изоляция)",
    foreignUpdate.status === 404,
    `HTTP ${foreignUpdate.status}, ${shortBody(foreignUpdate)}`,
  );

  // --- Сводка ---
  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "2.2 cart negative",
    summary: { total: lines.length, failed: failed.length },
    lines,
    cartIds: [cartId, cart2Id],
  };
  const rep = await save(
    `stage2.2-cart-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
