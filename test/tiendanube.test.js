import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TiendanubeAPI } from '../src/tiendanube.js';
import { leerConfig } from '../src/config.js';

function fetchFalso(respuestas) {
  const llamadas = [];
  const fn = async (url, init) => {
    llamadas.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
    const r = respuestas.shift();
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status || 200, headers: r.headers || {} });
  };
  return { fn, llamadas };
}

const nuevaApi = (fn) => new TiendanubeAPI({ id: '123', token: 'tok', base: 'https://api.tiendanube.com/2025-03', userAgent: 'App (x)', fetchFn: fn });

test('lee variantes con paginación, SKU, stock y nombre', async () => {
  const pagina1 = Array.from({ length: 200 }, (_, i) => ({ id: i, name: { es: `P${i}` }, variants: [{ id: 10000 + i, sku: `S${i}`, stock: 1, values: [] }] }));
  const pagina2 = [{ id: 999, name: { es: 'Campera' }, variants: [{ id: 5, sku: ' TEST-A ', stock: null, values: [{ es: 'Azul' }] }] }];
  const { fn, llamadas } = fetchFalso([{ body: pagina1 }, { body: pagina2 }]);
  const v = await nuevaApi(fn).listarVariantes();
  assert.equal(v.length, 201);
  assert.equal(v[200].stock, null);
  assert.equal(v[200].nombre, 'Campera (Azul)');
  assert.match(llamadas[0].url, /^https:\/\/api\.tiendanube\.com\/2025-03\/123\/products\?page=1&per_page=200/);
  assert.match(llamadas[1].url, /page=2/);
  assert.equal(llamadas[0].headers.Authorization, 'Bearer tok');
  assert.equal(llamadas[0].headers['User-Agent'], 'App (x)');
});

test('ajustar stock usa action "variation" sobre la variante correcta', async () => {
  const { fn, llamadas } = fetchFalso([{ body: [{ id: 7, stock: 4 }] }]);
  const quedo = await nuevaApi(fn).ajustarStock(55, 7, -2);
  assert.equal(quedo, 4);
  assert.equal(llamadas[0].method, 'POST');
  assert.match(llamadas[0].url, /\/123\/products\/55\/variants\/stock$/);
  assert.deepEqual(llamadas[0].body, { action: 'variation', value: -2, id: 7 });
});

test('reintenta ante 429 y 500, y falla claro ante 401', async () => {
  const { fn } = fetchFalso([{ status: 429, headers: { 'x-rate-limit-reset': '10' } }, { status: 500 }, { body: [{ id: 7, stock: 1 }] }]);
  assert.equal(await nuevaApi(fn).ajustarStock(1, 7, 1), 1);
  const { fn: fn2 } = fetchFalso([{ status: 401, body: { error: 'Invalid access token' } }]);
  await assert.rejects(nuevaApi(fn2).listarVariantes(), /401/);
});

test('configuración: lee tiendas numeradas y detecta errores', () => {
  const { tiendas, problemas, cfg } = leerConfig({
    TIENDA_1_ID: '111', TIENDA_1_TOKEN: 'a', TIENDA_1_NOMBRE: 'Prueba A',
    TIENDA_2_ID: '222', TIENDA_2_TOKEN: 'b',
    TIENDA_3_ID: 'abc', TIENDA_3_TOKEN: 'c',
    TIENDA_4_ID: '444',
  });
  assert.deepEqual(tiendas.map((t) => t.id), ['111', '222']);
  assert.equal(tiendas[0].nombre, 'Prueba A');
  assert.equal(problemas.length, 2);
  assert.equal(cfg.modoPrueba, true); // por defecto, modo prueba
  assert.equal(leerConfig({ MODO_PRUEBA: 'false' }).cfg.modoPrueba, false);
});
