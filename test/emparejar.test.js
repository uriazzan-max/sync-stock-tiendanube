// Emparejamiento: SKU + variante (SKU por producto, como Hydra) y enlaces
// guardados (SKUs distintos entre tiendas, como Hydra ↔ For You Audaz).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sincronizar, igualar } from '../src/motor.js';
import { claveDe, normalizarTexto } from '../src/emparejar.js';
import { TiendaFalsa, armar } from './utiles.js';

const buscar = (tienda, sku, ...valores) =>
  tienda.variantes.find((v) => v.sku === sku && valores.every((x, i) => (v.valores || [])[i] === x));

test('normalizar texto: acentos, mayúsculas y espacios', () => {
  assert.equal(normalizarTexto('  Marrón   con MARRÓN '), 'marron con marron');
});

test('clave: modo sku+variante ignora el orden de las propiedades', () => {
  const e = { modo: 'sku+variante' };
  const a = claveDe({ sku: 'TEST-Gamulan', valores: ['Marrón', 'S'] }, '1', e);
  const b = claveDe({ sku: 'test-gamulan ', valores: ['s', 'marron'] }, '2', e);
  assert.equal(a, b);
  assert.notEqual(a, claveDe({ sku: 'TEST-Gamulan', valores: ['Marrón', 'M'] }, '1', e));
});

test('clave: un enlace guardado gana sobre el SKU', () => {
  const enlaces = new Map([['1:55', 'g1']]);
  assert.equal(claveDe({ sku: 'X', varianteId: 55 }, '1', { enlaces }), 'enlace:g1');
  assert.equal(claveDe({ sku: 'X', varianteId: 56 }, '1', { enlaces }), 'X');
  assert.equal(claveDe({ sku: '', varianteId: 99 }, '1', { enlaces }), '');
});

function tiendasConSkuPorProducto() {
  // Como Hydra: todas las variantes del producto comparten el SKU
  const A = new TiendaFalsa('A', [
    { sku: 'TEST-Pantalon Frida', valores: ['Negro', 'S'], stock: 19 },
    { sku: 'TEST-Pantalon Frida', valores: ['Negro', 'M'], stock: 8 },
    { sku: 'TEST-Pantalon Frida', valores: ['Blanco', 'S'], stock: 8 },
  ]);
  // El orden de las propiedades y los acentos pueden variar entre tiendas
  const B = new TiendaFalsa('B', [
    { sku: 'TEST-Pantalon Frida', valores: ['S', 'negro'], stock: 19 },
    { sku: 'TEST-Pantalon Frida', valores: ['M', 'Negro'], stock: 8 },
    { sku: 'TEST-Pantalon Frida', valores: ['S', 'Blanco'], stock: 8 },
  ]);
  return { A, B };
}

test('modo sku: SKU compartido por todas las variantes = repetido, no se toca', async () => {
  const { A, B } = tiendasConSkuPorProducto();
  const c = armar([A, B], { emparejar: 'sku' });
  await sincronizar(c);
  buscar(A, 'TEST-Pantalon Frida', 'Negro', 'S').stock = 18;
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 0);
  assert.equal(B.escrituras.length, 0);
});

test('modo sku+variante: la venta de Negro S baja solo Negro S en la otra tienda', async () => {
  const { A, B } = tiendasConSkuPorProducto();
  const c = armar([A, B], { emparejar: 'sku+variante' });
  await sincronizar(c);
  buscar(A, 'TEST-Pantalon Frida', 'Negro', 'S').stock = 17;
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 1);
  assert.equal(buscar(B, 'TEST-Pantalon Frida', 'S', 'negro').stock, 17);
  assert.equal(buscar(B, 'TEST-Pantalon Frida', 'M', 'Negro').stock, 8);
  assert.equal(buscar(B, 'TEST-Pantalon Frida', 'S', 'Blanco').stock, 8);
  // y al revés
  buscar(B, 'TEST-Pantalon Frida', 'S', 'Blanco').stock = 13;
  await sincronizar(c);
  assert.equal(buscar(A, 'TEST-Pantalon Frida', 'Blanco', 'S').stock, 13);
});

test('enlaces: variantes con SKU distinto en cada tienda se sincronizan', async () => {
  // Como Hydra (SKU = nombre largo) ↔ For You Audaz (SKU = código)
  const A = new TiendaFalsa('A', [{ sku: 'TEST-Pantalon Tejido Frida', valores: ['Negro', 'S'], stock: 19 }]);
  const B = new TiendaFalsa('B', [{ sku: 'TEST-7746PV24', valores: ['Negro', 'S'], stock: 19 }]);
  const c = armar([A, B], { emparejar: 'sku+variante' });
  c.db.guardarEnlaces([{ miembros: [{ tienda: '1', varianteId: A.variantes[0].varianteId }, { tienda: '2', varianteId: B.variantes[0].varianteId }] }]);
  await sincronizar(c);
  A.variantes[0].stock = 16;
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 1);
  assert.equal(B.variantes[0].stock, 16);
});

test('enlaces: una variante sin SKU también se puede enlazar', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-x', stock: 5 }]);
  const B = new TiendaFalsa('B', [{ sku: '', stock: 5 }]);
  const c = armar([A, B], { emparejar: 'sku', modoPrueba: false });
  c.db.guardarEnlaces([{ grupo: 'gamulan-s', miembros: [{ tienda: '1', varianteId: A.variantes[0].varianteId }, { tienda: '2', varianteId: B.variantes[0].varianteId }] }]);
  await sincronizar(c);
  B.variantes[0].stock = 3;
  await sincronizar(c);
  assert.equal(A.variantes[0].stock, 3);
});

test('modo prueba + enlace: si una de las variantes no es TEST-, no se toca nada', async () => {
  const A = new TiendaFalsa('A', [{ sku: 'TEST-x', stock: 5 }]);
  const B = new TiendaFalsa('B', [{ sku: 'REAL-y', stock: 5 }]);
  const c = armar([A, B]);
  c.db.guardarEnlaces([{ miembros: [{ tienda: '1', varianteId: A.variantes[0].varianteId }, { tienda: '2', varianteId: B.variantes[0].varianteId }] }]);
  await sincronizar(c);
  A.variantes[0].stock = 2;
  const r = await sincronizar(c);
  await igualar({ ...c, referencia: '1' });
  assert.equal(r.ajustes, 0);
  assert.equal(B.variantes[0].stock, 5);
  assert.deepEqual(B.escrituras, []);
});

test('enlaces: volver a guardar una variante la mueve de grupo, no la duplica', async () => {
  const { db } = armar([new TiendaFalsa('A', []), new TiendaFalsa('B', [])]);
  db.guardarEnlaces([{ grupo: 'g1', miembros: [{ tienda: '1', varianteId: '10' }, { tienda: '2', varianteId: '20' }] }]);
  db.guardarEnlaces([{ grupo: 'g2', miembros: [{ tienda: '1', varianteId: '10' }, { tienda: '2', varianteId: '21' }] }]);
  assert.equal(db.mapaEnlaces().get('1:10'), 'g2');
  assert.equal(db.listarEnlaces().filter((e) => e.tienda === '1').length, 1);
});

test('igualar en modo sku+variante iguala cada variante con su par', async () => {
  const { A, B } = tiendasConSkuPorProducto();
  buscar(B, 'TEST-Pantalon Frida', 'M', 'Negro').stock = 2;
  const c = armar([A, B], { emparejar: 'sku+variante' });
  const r = await igualar({ ...c, referencia: '1' });
  assert.equal(r.igualados, 1);
  assert.equal(buscar(B, 'TEST-Pantalon Frida', 'M', 'Negro').stock, 8);
  assert.equal(buscar(B, 'TEST-Pantalon Frida', 'S', 'negro').stock, 19);
});

test('parsear enlaces escritos como texto', async () => {
  const { parsearEnlaces } = await import('../src/emparejar.js');
  const r = parsearEnlaces(
    '8319495:111 = 8319532:222  # Gamulan S\n\n8319495:112, 8319532:223\nbasura\n8319495:1 = 999:2\n8319495:1 = 8319495:2',
    ['8319495', '8319532'],
  );
  assert.equal(r.grupos.length, 2);
  assert.deepEqual(r.grupos[0], { miembros: [{ tienda: '8319495', varianteId: '111' }, { tienda: '8319532', varianteId: '222' }], nota: 'Gamulan S' });
  assert.equal(r.errores.length, 3);
});

test('clave de producto por tienda: SKU en una (Hydra) = nombre en la otra (For You Audaz)', async () => {
  // Hydra: SKU = nombre del producto en For You Audaz
  const H = new TiendaFalsa('Hydra', [
    { sku: 'TEST-Pantalon Tejido Frida CU1031 A10A', producto: 'Pantalon Guillermina', valores: ['Negro', 'S'], stock: 19 },
    { sku: 'TEST-Pantalon Tejido Frida CU1031 A10A', producto: 'Pantalon Guillermina', valores: ['Blanco', 'S'], stock: 8 },
  ]);
  // For You Audaz: SKU = código propio; el nombre es lo que coincide
  const F = new TiendaFalsa('FYA', [
    { sku: 'TEST-7746PV24', producto: 'TEST-PANTALON TEJIDO FRIDA CU1031 A10A', valores: ['S', 'Negro'], stock: 19 },
    { sku: 'TEST-7746PV24', producto: 'TEST-PANTALON TEJIDO FRIDA CU1031 A10A', valores: ['S', 'Blanco'], stock: 8 },
  ]);
  const c = armar([H, F], { emparejar: 'sku+variante', claveProducto: { 1: 'sku', 2: 'nombre' } });
  await sincronizar(c);
  F.variantes[0].stock = 15; // venta de 4 Negro S en For You Audaz
  const r = await sincronizar(c);
  assert.equal(r.ajustes, 1);
  assert.equal(H.variantes[0].stock, 15);
  assert.equal(H.variantes[1].stock, 8);
});

test('config: TIENDA_n_CLAVE se lee y valida', async () => {
  const { leerConfig } = await import('../src/config.js');
  const r = leerConfig({ TIENDA_1_ID: '1', TIENDA_1_TOKEN: 'a', TIENDA_2_ID: '2', TIENDA_2_TOKEN: 'b', TIENDA_2_CLAVE: 'Nombre', TIENDA_1_CLAVE: 'otra', EMPAREJAR: 'sku+variante' });
  assert.deepEqual(r.cfg.claveProducto, { 1: 'sku', 2: 'nombre' });
  assert.equal(r.cfg.emparejar, 'sku+variante');
  assert.equal(r.problemas.length, 1);
});
