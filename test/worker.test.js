// Prueba de punta a punta del Worker: rutas, panel, webhook, cron y el
// Durable Object, contra una API de Tiendanube simulada por HTTP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqlFalso } from './utiles.js';

const { default: worker, Sincronizador } = await import('../src/index.js');

// API de Tiendanube simulada: dos tiendas con productos y stock
function apiFalsa() {
  const tiendas = {
    111: [{ id: 1, name: { es: 'Campera Test A' }, variants: [{ id: 11, sku: 'TEST-CAMP-AZUL', stock: 10, values: [{ es: 'Azul' }] }, { id: 12, sku: 'REAL-NEGRO', stock: 5, values: [] }] }],
    222: [{ id: 2, name: { es: 'Campera Test B' }, variants: [{ id: 21, sku: 'TEST-CAMP-AZUL', stock: 7, values: [{ es: 'Azul' }] }, { id: 22, sku: 'REAL-NEGRO', stock: 5, values: [] }] }],
  };
  const webhooks = { 111: [], 222: [] };
  const log = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    const [, , tienda, ...resto] = u.pathname.split('/');
    const ruta = '/' + resto.join('/');
    log.push(`${init.method || 'GET'} ${tienda}${ruta}`);
    if (init.headers?.Authorization !== `Bearer tok${tienda}`) return new Response('{"error":"bad token"}', { status: 401 });
    if (ruta === '/products') return Response.json(Number(u.searchParams.get('page')) === 1 ? tiendas[tienda] : []);
    const m = ruta.match(/^\/products\/(\d+)\/variants\/stock$/);
    if (m) {
      const b = JSON.parse(init.body);
      const v = tiendas[tienda].find((p) => p.id == m[1]).variants.find((x) => x.id === b.id);
      v.stock = b.action === 'replace' ? b.value : Math.max(0, v.stock + b.value);
      return Response.json([v]);
    }
    if (ruta === '/webhooks' && init.method === 'POST') {
      webhooks[tienda].push({ id: webhooks[tienda].length + 1, ...JSON.parse(init.body) });
      return Response.json({ ok: true }, { status: 201 });
    }
    if (ruta === '/webhooks') return Response.json(webhooks[tienda]);
    return new Response('{}', { status: 404 });
  };
  return { tiendas, webhooks, log, fetchFn };
}

function entorno(api) {
  const env = {
    TIENDA_1_ID: '111', TIENDA_1_TOKEN: 'tok111', TIENDA_1_NOMBRE: 'Prueba A',
    TIENDA_2_ID: '222', TIENDA_2_TOKEN: 'tok222', TIENDA_2_NOMBRE: 'Prueba B',
    ADMIN_CLAVE: 'secreta123', WEBHOOK_SECRETO: 'abc123xyz',
    MODO_PRUEBA: 'true', PREFIJO_PRUEBA: 'TEST-', MAX_ESCRITURAS: '25', API_BASE: 'https://api.tiendanube.com/2025-03',
  };
  let alarma = null;
  const ctx = { storage: { sql: new SqlFalso(), getAlarm: async () => alarma, setAlarm: async (t) => { alarma = t; } } };
  globalThis.fetch = api.fetchFn;
  const instancia = new Sincronizador(ctx, env);
  env.SINCRONIZADOR = { idFromName: () => 'x', get: () => instancia };
  const pendientes = [];
  const ctxWorker = { waitUntil: (p) => pendientes.push(p) };
  return { env, ctxWorker, instancia, esperar: () => Promise.all(pendientes.splice(0)), alarma: () => alarma };
}

const auth = { Authorization: 'Basic ' + btoa('uri:secreta123') };

test('el panel pide clave y la acepta', async () => {
  const api = apiFalsa();
  const e = entorno(api);
  let r = await worker.fetch(new Request('https://x.dev/admin'), e.env, e.ctxWorker);
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://x.dev/admin', { headers: { Authorization: 'Basic ' + btoa('uri:mal') } }), e.env, e.ctxWorker);
  assert.equal(r.status, 401);
  r = await worker.fetch(new Request('https://x.dev/admin', { headers: auth }), e.env, e.ctxWorker);
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /MODO PRUEBA/);
  assert.match(h, /Prueba A \(111\) ↔ Prueba B \(222\)/);
});

test('flujo completo: cron, venta, webhook, panel; el SKU real no se toca', async () => {
  const api = apiFalsa();
  const e = entorno(api);
  await worker.scheduled({}, e.env, e.ctxWorker);
  await e.esperar();

  // venta en A
  api.tiendas[111][0].variants[0].stock = 9;
  api.tiendas[111][0].variants[1].stock = 4; // SKU real: no debe pasar a B

  // webhook con secreto incorrecto: 404 y no agenda nada
  let r = await worker.fetch(new Request('https://x.dev/webhook/otro', { method: 'POST', body: '{}' }), e.env, e.ctxWorker);
  assert.equal(r.status, 404);
  r = await worker.fetch(new Request('https://x.dev/webhook/abc123xyz', { method: 'POST', body: '{"store_id":111,"event":"order/paid","id":1}' }), e.env, e.ctxWorker);
  assert.equal(r.status, 200);
  await e.esperar();
  assert.ok(e.alarma(), 'el webhook agenda una corrida');
  await e.instancia.alarm();

  assert.equal(api.tiendas[222][0].variants[0].stock, 6);
  assert.equal(api.tiendas[222][0].variants[1].stock, 5);

  r = await worker.fetch(new Request('https://x.dev/admin', { headers: auth }), e.env, e.ctxWorker);
  const h = await r.text();
  assert.match(h, /Ajuste aplicado/);
  assert.match(h, /TEST-CAMP-AZUL/);
  assert.doesNotMatch(h, /tok111|tok222/, 'los tokens nunca aparecen en el panel');
});

test('registrar webhooks desde el panel (sin duplicar) e igualar', async () => {
  const api = apiFalsa();
  const e = entorno(api);
  const post = (ruta, campos = {}) =>
    worker.fetch(new Request(`https://x.dev${ruta}`, { method: 'POST', headers: auth, body: new URLSearchParams(campos) }), e.env, e.ctxWorker);
  await post('/admin/webhooks-registrar');
  await post('/admin/webhooks-registrar');
  assert.equal(api.webhooks[111].length, 5);
  assert.equal(api.webhooks[111][0].url, 'https://x.dev/webhook/abc123xyz');
  const ver = await (await post('/admin/webhooks-ver')).text();
  assert.doesNotMatch(ver, /abc123xyz/, 'el secreto del webhook no se muestra');

  const sinConfirmar = await (await post('/admin/igualar', { referencia: '111', confirmar: 'no' })).text();
  assert.match(sinConfirmar, /escribir IGUALAR/);
  assert.equal(api.tiendas[222][0].variants[0].stock, 7);
  await post('/admin/igualar', { referencia: '111', confirmar: 'IGUALAR' });
  assert.equal(api.tiendas[222][0].variants[0].stock, 10);
  assert.equal(api.tiendas[222][0].variants[1].stock, 5, 'igualar respeta el modo prueba');
});

test('diagnóstico de conexión: muestra solo los últimos 4 caracteres del token', async () => {
  const api = apiFalsa();
  const e = entorno(api);
  const r = await worker.fetch(new Request('https://x.dev/admin/diagnostico', { method: 'POST', headers: auth, body: new URLSearchParams() }), e.env, e.ctxWorker);
  const h = await r.text();
  assert.match(h, /termina en \.\.\.k111/);
  assert.doesNotMatch(h, /tok111|tok222/);
  assert.match(h, /Prueba A \(111\) · API 2025-03 · Authorization: OK/);
  assert.match(h, /Prueba B \(222\) · API 2025-03 · Authorization: 401/);
});

test('panel: importar enlaces y verlos contados', async () => {
  const api = apiFalsa();
  const e = entorno(api);
  const post = (ruta, campos = {}) =>
    worker.fetch(new Request(`https://x.dev${ruta}`, { method: 'POST', headers: auth, body: new URLSearchParams(campos) }), e.env, e.ctxWorker);
  const h = await (await post('/admin/enlaces-importar', { lineas: '111:12 = 222:22 # negro\n111:x = 222:1' })).text();
  assert.match(h, /&quot;guardados&quot;: 1/);
  assert.match(h, /1 enlaces guardados/);
  const sinConfirmar = await (await post('/admin/enlaces-borrar', { confirmar: 'no' })).text();
  assert.match(sinConfirmar, /1 enlaces guardados/);
  const borrado = await (await post('/admin/enlaces-borrar', { confirmar: 'BORRAR' })).text();
  assert.match(borrado, /0 enlaces guardados/);
});
