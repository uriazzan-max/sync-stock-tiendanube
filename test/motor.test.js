import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizar, igualar } from '../src/motor.js';
import { TiendaFalsa, armar } from './utiles.js';

// Las mismas tiendas de prueba reales: A y B con stock distinto a propósito
function tiendasDePrueba() {
  const A = new TiendaFalsa('A', [
    { sku: 'TEST-CAMP-AZUL', stock: 10 },
    { sku: 'TEST-CAMP-BEIGE', stock: 8 },
    { sku: 'TEST-SOLO-A', stock: 4 },
  ]);
  const B = new TiendaFalsa('B', [
    { sku: 'TEST-CAMP-AZUL', stock: 7 },
    { sku: 'TEST-CAMP-BEIGE', stock: 5 },
    { sku: 'TEST-SOLO-B', stock: 3 },
  ]);
  return { A, B, c: armar([A, B]) };
}

test('primera corrida: toma el punto de partida sin mover stock', async () => {
  const { A, B, c } = tiendasDePrueba();
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 0);
  assert.equal(r.errores.length, 0);
  assert.deepEqual(A.escrituras, []);
  assert.deepEqual(B.escrituras, []);
});

test('venta en A descuenta en B (y solo en B)', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 1);
  const r = await sincronizar(c);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 6);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 9);
  assert.equal(r.ajustes, 1);
  assert.deepEqual(A.escrituras, []);
});

test('sin eco: la corrida siguiente no vuelve a mover nada', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 2);
  await sincronizar(c);
  const r = await sincronizar(c);
  const r2 = await sincronizar(c);
  assert.equal(r.ajustes + r2.ajustes, 0);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 8);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 5);
});

test('cancelación (vuelve stock) en A suma en B', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-BEIGE', 2);
  await sincronizar(c);
  A.sumar('TEST-CAMP-BEIGE', 2); // pedido cancelado
  await sincronizar(c);
  assert.equal(A.stock('TEST-CAMP-BEIGE'), 8);
  assert.equal(B.stock('TEST-CAMP-BEIGE'), 5);
});

test('carga manual de mercadería en B suma en A', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  B.sumar('TEST-CAMP-BEIGE', 5);
  await sincronizar(c);
  assert.equal(A.stock('TEST-CAMP-BEIGE'), 13);
  assert.equal(B.stock('TEST-CAMP-BEIGE'), 10);
});

test('ventas simultáneas en A y B del mismo SKU: cada una recibe la de la otra', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 1);
  B.vender('TEST-CAMP-AZUL', 2);
  await sincronizar(c);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 7); // 10 - 1 - 2
  assert.equal(B.stock('TEST-CAMP-AZUL'), 4); // 7 - 2 - 1
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 0);
});

test('venta que entra entre la lectura y el ajuste no se pierde', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 1);
  B.antesDeEscribir = () => B.vender('TEST-CAMP-AZUL', 1); // venta en B justo antes del ajuste
  await sincronizar(c);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 5); // 7 - 1 (propia) - 1 (de A)
  assert.equal(A.stock('TEST-CAMP-AZUL'), 9); // todavía no se enteró
  await sincronizar(c);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 8); // ahora sí
  assert.equal(B.stock('TEST-CAMP-AZUL'), 5);
});

test('si falla un ajuste queda pendiente y se reintenta sin duplicar', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 1);
  B.fallarEscrituras = 1;
  const r1 = await sincronizar(c);
  assert.equal(r1.errores.length, 1);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 7);
  const r2 = await sincronizar(c);
  assert.equal(r2.errores.length, 0);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 6);
  await sincronizar(c);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 6);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 9);
});

test('si no se puede leer una tienda, no se toca nada', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-CAMP-AZUL', 1);
  B.fallarLectura = true;
  const r = await sincronizar(c);
  assert.equal(r.errores.length, 1);
  assert.deepEqual(B.escrituras, []);
  B.fallarLectura = false;
  await sincronizar(c);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 6);
});

test('productos sin par no se tocan', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  A.vender('TEST-SOLO-A', 1);
  B.vender('TEST-SOLO-B', 1);
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 0);
  assert.equal(r.sinPar, 2);
});

test('modo prueba: un SKU real (sin TEST-) nunca se toca', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'CAMP-REAL-NEGRO', stock: 10 }]);
  const B = new TiendaFalsa('B', [{ sku: 'CAMP-REAL-NEGRO', stock: 10 }]);
  const c = armar([A, B]);
  await sincronizar(c);
  A.vender('CAMP-REAL-NEGRO', 3);
  await sincronizar(c);
  assert.equal(B.stock('CAMP-REAL-NEGRO'), 10);
  assert.deepEqual(B.escrituras, []);
});

test('modo real: el mismo SKU sí se sincroniza', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'CAMP-REAL-NEGRO', stock: 10 }]);
  const B = new TiendaFalsa('B', [{ sku: 'CAMP-REAL-NEGRO', stock: 10 }]);
  const c = armar([A, B], { modoPrueba: false });
  await sincronizar(c);
  A.vender('CAMP-REAL-NEGRO', 3);
  await sincronizar(c);
  assert.equal(B.stock('CAMP-REAL-NEGRO'), 7);
});

test('sobreventa: las dos venden la última unidad, quedan en 0 y se anota', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-X', stock: 1 }]);
  const B = new TiendaFalsa('B', [{ sku: 'TEST-X', stock: 1 }]);
  const c = armar([A, B]);
  await sincronizar(c);
  A.vender('TEST-X', 1);
  B.vender('TEST-X', 1);
  await sincronizar(c);
  assert.equal(A.stock('TEST-X'), 0);
  assert.equal(B.stock('TEST-X'), 0);
  const sobreventas = c.db.ultimosMovimientos().filter((m) => m.tipo === 'sobreventa');
  assert.equal(sobreventas.length, 2);
  const r = await sincronizar(c); // no debe "devolver" stock fantasma
  assert.equal(r.ajustes, 0);
  assert.equal(A.stock('TEST-X'), 0);
  assert.equal(B.stock('TEST-X'), 0);
});

test('SKU repetido dentro de una tienda: se ignora', async () => {
  const A = new TiendaFalsa('A', [
    { sku: 'TEST-DUP', stock: 5 },
    { sku: 'TEST-DUP', stock: 2 },
  ]);
  const B = new TiendaFalsa('B', [{ sku: 'TEST-DUP', stock: 5 }]);
  const c = armar([A, B]);
  await sincronizar(c);
  B.vender('TEST-DUP', 1);
  await sincronizar(c);
  assert.deepEqual(A.escrituras, []);
});

test('stock infinito y variantes sin SKU: se ignoran', async () => {
  const A = new TiendaFalsa('A', [
    { sku: 'TEST-INF', stock: null },
    { sku: null, stock: 4 },
    { sku: '   ', stock: 4 },
  ]);
  const B = new TiendaFalsa('B', [
    { sku: 'TEST-INF', stock: 5 },
    { sku: null, stock: 4 },
  ]);
  const c = armar([A, B]);
  await sincronizar(c);
  B.vender('TEST-INF', 1);
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 0);
  assert.equal(r.errores.length, 0);
});

test('igualar desde A deja B igual, y después sigue sincronizando', async () => {
  const { A, B, c } = tiendasDePrueba();
  await sincronizar(c);
  const r = await igualar({ ...c, referencia: '1' });
  assert.equal(r.igualados, 2);
  assert.equal(B.stock('TEST-CAMP-AZUL'), 10);
  assert.equal(B.stock('TEST-CAMP-BEIGE'), 8);
  assert.equal(B.stock('TEST-SOLO-B'), 3); // sin par: intacto
  const r2 = await sincronizar(c);
  assert.equal(r2.ajustes, 0); // igualar no genera "cambios" falsos
  B.vender('TEST-CAMP-AZUL', 1);
  await sincronizar(c);
  assert.equal(A.stock('TEST-CAMP-AZUL'), 9);
});

test('límite de escrituras por corrida: lo que falta queda pendiente y se completa', async () => {
  const skus = Array.from({ length: 6 }, (_, i) => `TEST-${i}`);
  const A = new TiendaFalsa('A', skus.map((sku) => ({ sku, stock: 10 })));
  const B = new TiendaFalsa('B', skus.map((sku) => ({ sku, stock: 10 })));
  const c = armar([A, B], { maxEscrituras: 4 });
  await sincronizar(c);
  for (const s of skus) A.vender(s, 1);
  const r1 = await sincronizar(c);
  assert.equal(r1.ajustes, 4);
  assert.equal(r1.pendientes, 2);
  await sincronizar(c);
  for (const s of skus) assert.equal(B.stock(s), 9);
  const r3 = await sincronizar(c);
  assert.equal(r3.ajustes, 0);
});

test('tres tiendas: una venta baja en las otras dos', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-X', stock: 10 }]);
  const B = new TiendaFalsa('B', [{ sku: 'TEST-X', stock: 10 }]);
  const C = new TiendaFalsa('C', [{ sku: 'TEST-X', stock: 10 }]);
  const c = armar([A, B, C]);
  await sincronizar(c);
  B.vender('TEST-X', 2);
  C.vender('TEST-X', 1);
  await sincronizar(c);
  assert.equal(A.stock('TEST-X'), 7);
  assert.equal(B.stock('TEST-X'), 7);
  assert.equal(C.stock('TEST-X'), 7);
});

test('si una sola tienda está configurada, no hace nada', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-X', stock: 10 }]);
  const c = armar([A]);
  const r = await sincronizar(c);
  assert.equal(r.errores.length, 1);
});

test('una corrida sin ventas no escribe en la base de datos', async () => {
  const { c } = tiendasDePrueba();
  await sincronizar(c);
  const antes = c.sql.escrituras;
  await sincronizar(c);
  await sincronizar(c);
  assert.equal(c.sql.escrituras, antes);
});

test('muchas ventas y cargas alternadas: las dos tiendas terminan iguales', async () => {
  const { A, B, c } = tiendasDePrueba();
  await igualar({ ...c, referencia: '1' });
  for (let i = 0; i < 8; i++) {
    if (i % 2) A.vender('TEST-CAMP-AZUL', 1);
    else B.vender('TEST-CAMP-AZUL', 1);
    if (i % 3 === 0) B.sumar('TEST-CAMP-BEIGE', 1);
    await sincronizar(c);
  }
  assert.equal(A.stock('TEST-CAMP-AZUL'), B.stock('TEST-CAMP-AZUL'));
  assert.equal(A.stock('TEST-CAMP-AZUL'), 2);
  assert.equal(A.stock('TEST-CAMP-BEIGE'), B.stock('TEST-CAMP-BEIGE'));
});

test('igualar a medias (límite de escrituras) no genera descuentos dobles', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-X', stock: 10 }]);
  const B = new TiendaFalsa('B', [{ sku: 'TEST-X', stock: 7 }]);
  const C = new TiendaFalsa('C', [{ sku: 'TEST-X', stock: 4 }]);
  const c = armar([A, B, C], { maxEscrituras: 1 });
  await sincronizar(c);
  A.vender('TEST-X', 1); // venta todavía no sincronizada
  const r = await igualar({ ...c, referencia: '1' });
  assert.equal(r.igualados, 1);
  assert.equal(r.faltan, 1);
  assert.equal(B.stock('TEST-X'), 9);
  const r2 = await sincronizar(c);
  assert.equal(r2.ajustes, 0, 'la venta ya quedó reflejada al igualar');
  assert.equal(B.stock('TEST-X'), 9);
  await igualar({ ...c, referencia: '1' });
  assert.equal(C.stock('TEST-X'), 9);
  A.vender('TEST-X', 2);
  await sincronizar(c);
  await sincronizar(c);
  assert.deepEqual([A.stock('TEST-X'), B.stock('TEST-X'), C.stock('TEST-X')], [7, 7, 7]);
});
