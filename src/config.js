// Lee la configuración desde las variables y secretos de Cloudflare.
//
// Tiendas: TIENDA_1_ID + TIENDA_1_TOKEN (+ TIENDA_1_NOMBRE opcional),
//          TIENDA_2_ID + TIENDA_2_TOKEN, ... hasta TIENDA_20.
// Todas las tiendas configuradas se sincronizan entre sí.

import { TiendanubeAPI } from './tiendanube.js';
import { MODOS } from './emparejar.js';

export const USER_AGENT = 'Sync Stock Tiendanube (https://github.com/uriazzan-max/sync-stock-tiendanube)';

export function leerConfig(env) {
  const tiendas = [];
  const problemas = [];
  for (let n = 1; n <= 20; n++) {
    const id = (env[`TIENDA_${n}_ID`] || '').trim();
    const token = (env[`TIENDA_${n}_TOKEN`] || '').trim();
    if (!id && !token) continue;
    if (!id || !token) {
      problemas.push(`La tienda ${n} tiene ${id ? 'ID' : 'token'} pero le falta ${id ? 'el token' : 'el ID'}`);
      continue;
    }
    if (!/^\d+$/.test(id)) {
      problemas.push(`TIENDA_${n}_ID tiene que ser solo números (el store ID), y es "${id}"`);
      continue;
    }
    let clave = String(env[`TIENDA_${n}_CLAVE`] || 'sku').trim().toLowerCase();
    if (!['sku', 'nombre'].includes(clave)) {
      problemas.push(`TIENDA_${n}_CLAVE tiene que ser "sku" o "nombre", y es "${clave}". Se usa "sku".`);
      clave = 'sku';
    }
    tiendas.push({ n, id, token, clave, nombre: (env[`TIENDA_${n}_NOMBRE`] || `Tienda ${n}`).trim() });
  }
  const modoPrueba = String(env.MODO_PRUEBA ?? 'true').toLowerCase() !== 'false';
  const prefijoPrueba = String(env.PREFIJO_PRUEBA || 'TEST-');
  const maxEscrituras = Math.max(1, Math.min(200, Number(env.MAX_ESCRITURAS) || 25));
  const apiBase = env.API_BASE || 'https://api.tiendanube.com/2025-03';
  let emparejar = String(env.EMPAREJAR || 'sku').trim().toLowerCase();
  if (!MODOS.includes(emparejar)) {
    problemas.push(`EMPAREJAR tiene que ser ${MODOS.map((m) => `"${m}"`).join(' o ')}, y es "${emparejar}". Se usa "sku".`);
    emparejar = 'sku';
  }
  const claveProducto = Object.fromEntries(tiendas.map((t) => [t.id, t.clave]));
  return { tiendas, problemas, cfg: { modoPrueba, prefijoPrueba, maxEscrituras, emparejar, claveProducto }, apiBase };
}

export function crearApis(tiendas, apiBase, fetchFn) {
  const apis = new Map();
  for (const t of tiendas) {
    apis.set(t.id, new TiendanubeAPI({ id: t.id, token: t.token, base: apiBase, userAgent: USER_AGENT, fetchFn }));
  }
  return apis;
}
