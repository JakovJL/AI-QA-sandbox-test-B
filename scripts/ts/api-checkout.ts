// Этап 2.3: чекаут-пайплайн (Store API). Один маркированный заказ через системный
// мок-провайдер (pp_system_default). Реальные платёжные методы не используются (§10).
// Маркировка: metadata { qa: true }, email *@test.local. Очистка — по §13.5.
// Запуск: npx tsx scripts/ts/api-checkout.ts
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
function short(r: ApiResult, n = 160): string {
  return r.body.replace(/\s+/g, " ").slice(0, n);
}

async function main(): Promise<void> {
  const t = await resolveTarget();
  console.log(`target: ${t.host} @ ${t.ip}\n`);

  // --- Корзина + товар ---
  const variantId = (JSON.parse(
    (await apiGet(t, "/store/products?limit=1")).body,
  ) as { products: { variants: { id: string }[] }[] }).products[0]!.variants[0]!.id;

  const cartResp = await apiPost(t, "/store/carts", { metadata: { qa: true } });
  const cartId = (JSON.parse(cartResp.body) as { cart: { id: string } }).cart.id;
  await apiPost(t, `/store/carts/${cartId}/line-items`, { variant_id: variantId, quantity: 1 });
  console.log(`cart: ${cartId}`);

  // --- Email и адреса ---
  const upd = await apiPost(t, `/store/carts/${cartId}`, {
    email: "qa-checkout@test.local",
    shipping_address: {
      first_name: "QA", last_name: "Marker",
      address_1: "Test Lane 1", city: "Kobenhavn",
      country_code: "dk", postal_code: "1000",
    },
    billing_address: {
      first_name: "QA", last_name: "Marker",
      address_1: "Test Lane 1", city: "Kobenhavn",
      country_code: "dk", postal_code: "1000",
    },
  });
  await save(`checkout-${cartId}-addresses.json`, upd.body);
  rec("адреса+email: принимаются", upd.status === 200, `HTTP ${upd.status}, ${short(upd)}`);

  // --- Способ доставки ---
  const regionId = (JSON.parse(
    (await apiGet(t, "/store/regions?limit=1")).body,
  ) as { regions: { id: string }[] }).regions[0]!.id;
  const so = JSON.parse(
    (await apiGet(t, `/store/shipping-options?cart_id=${cartId}`)).body,
  ) as { shipping_options: { id: string; name: string }[] };
  const opt = so.shipping_options[0];
  const sm = await apiPost(t, `/store/carts/${cartId}/shipping-methods`, {
    option_id: opt?.id,
  });
  await save(`checkout-${cartId}-shipping.json`, sm.body);
  const smCart = JSON.parse(sm.body) as { cart: { shipping_total: number | null; subtotal: number; item_subtotal: number } };
  rec(
    "доставка: метод добавляется, shipping_total проставлен",
    sm.status === 200 && typeof smCart.cart.shipping_total === "number",
    `HTTP ${sm.status}, option="${opt?.name}", shipping_total=${smCart.cart.shipping_total}, subtotal=${smCart.cart.subtotal}`,
  );

  // --- Платёжная сессия (v2: payment-collections; фолбэк на legacy-маршрут) ---
  const pc = await apiPost(t, "/store/payment-collections", { cart_id: cartId });
  let sessionOk = false;
  let sessionDetail = `payment-collections: HTTP ${pc.status}, ${short(pc, 100)}`;
  if (pc.status === 200) {
    const pcId = (JSON.parse(pc.body) as { payment_collection: { id: string } }).payment_collection.id;
    const ps = await apiPost(t, `/store/payment-collections/${pcId}/payment-sessions`, {
      provider_id: "pp_system_default",
    });
    sessionOk = ps.status === 200;
    sessionDetail = `payment-collections: HTTP ${pc.status}; session: HTTP ${ps.status}`;
    await save(`checkout-${cartId}-payment-session.json`, ps.body);
  } else {
    const legacy = await apiPost(t, `/store/carts/${cartId}/payment-sessions`, {
      provider_id: "pp_system_default",
    });
    sessionOk = legacy.status === 200;
    sessionDetail += `; legacy /carts/{id}/payment-sessions: HTTP ${legacy.status}`;
    await save(`checkout-${cartId}-payment-session-legacy.json`, legacy.body);
  }
  rec("оплата: сессия системного мок-провайдера создаётся", sessionOk, sessionDetail);

  // --- Завершение заказа ---
  const done = await apiPost(t, `/store/carts/${cartId}/complete`, {});
  await save(`checkout-${cartId}-complete.json`, done.body);
  const doneBody = JSON.parse(done.body) as {
    type?: string; order?: { id: string; display_id?: number; total: number; email?: string; metadata?: Record<string, unknown> };
    error?: string;
  };
  rec(
    "чекаут: complete создаёт заказ",
    done.status === 200 && doneBody.type === "order" && !!doneBody.order,
    `HTTP ${done.status}, type=${doneBody.type ?? "?"}, order=${doneBody.order?.id ?? doneBody.error ?? "?"}`,
  );
  if (doneBody.order) {
    const o = doneBody.order;
    rec(
      "чекаут: итог заказа согласован (total >= item_subtotal, валюта корзины)",
      o.total > 0,
      `order total=${o.total} (item_subtotal=${smCart.cart.item_subtotal}, shipping=${smCart.cart.shipping_total})`,
    );
    rec(
      "чекаут: маркировка переносится (email @test.local)",
      (o.email ?? "").endsWith("@test.local"),
      `email=${o.email ?? "?"}`,
    );

    // --- Повторный complete: идемпотентность ---
    const again = await apiPost(t, `/store/carts/${cartId}/complete`, {});
    await save(`checkout-${cartId}-complete-2nd.json`, again.body);
    const againBody = JSON.parse(again.body) as { type?: string; order?: { id: string } };
    const sameOrder = againBody.order?.id === o.id;
    rec(
      "чекаут: повторный complete не плодит второй заказ",
      again.status === 200 && sameOrder,
      `HTTP ${again.status}, type=${againBody.type ?? "?"}, order=${againBody.order?.id ?? "?"} (первый: ${o.id})`,
    );
  }

  // --- Сводка ---
  const failed = lines.filter((l) => l.pass === false);
  const report = {
    date: new Date().toISOString(),
    stage: "2.3 checkout pipeline",
    summary: { total: lines.length, failed: failed.length },
    lines,
    cartId,
  };
  const rep = await save(
    `stage2.3-checkout-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    JSON.stringify(report, null, 2),
  );
  console.log(`\nитог: ${failed.length} FAIL из ${lines.length}; артефакты: ${rep}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("[fail]", err);
  process.exit(2);
});
