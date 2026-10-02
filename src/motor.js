// Motor de sincronización de stock entre tiendas Tiendanube.
//
// IDEA CENTRAL (por diferencia, no copiando el stock):
//   Para cada SKU y cada tienda guardamos una "base": el último stock que
//   ya tenemos contabilizado. En cada corrida leemos el stock actual:
//
//     cambio de la tienda   d = stock_actual - base
//     cambio total del SKU  T = suma de los d de todas las tiendas
//     ajuste a aplicar      v = T - d + pendiente
//
//   Cada tienda recibe los cambios de las DEMÁS (nunca el suyo propio).
//   Después de ajustar, la base queda en "stock_leído + ajuste". Como el
//   ajuste ya está contabilizado, la próxima corrida ve d = 0 y no hay eco
//   ni bucle. Si entre la lectura y el ajuste entra otra venta, queda como
//   diferencia y se sincroniza en la corrida siguiente (no se pierde).
//
//   Si un ajuste falla (red caída, error de la API), queda guardado como
//   "pendiente" y se reintenta en la próxima corrida.

/** Agrupa las variantes por SKU. SKUs repetidos en una misma tienda se marcan. */
export function indexarPorSku(variantes) {
  const mapa = new Map();
  for (const v of variantes) {
    const sku = normalizarSku(v.sku);
    if (!sku) continue; // variantes sin SKU: se ignoran siempre
    if (mapa.has(sku)) {
      mapa.get(sku).duplicado = true;
      continue;
    }
    mapa.set(sku, { ...v, sku, duplicado: false });
  }
  return mapa;
}

export function normalizarSku(sku) {
  if (sku === null || sku === undefined) return '';
  return String(sku).trim();
}

/** El filtro de seguridad del modo prueba. */
export function skuPermitido(sku, cfg) {
  if (!cfg.modoPrueba) return true;
  return sku.startsWith(cfg.prefijoPrueba);
}

function guardiaPrueba(sku, cfg) {
  if (!skuPermitido(sku, cfg)) {
    throw new Error(`Bloqueado por modo prueba: el SKU "${sku}" no empieza con "${cfg.prefijoPrueba}"`);
  }
}

async function leerTodas(tiendas, apis) {
  const fotos = new Map();
  const errores = [];
  await Promise.all(
    tiendas.map(async (t) => {
      try {
        fotos.set(t.id, indexarPorSku(await apis.get(t.id).listarVariantes()));
      } catch (e) {
        errores.push({ tienda: t.id, error: String(e.message || e) });
      }
    }),
  );
  return { fotos, errores };
}

/**
 * Una pasada completa de sincronización.
 * @param {object} o
 * @param {{id:string,nombre:string}[]} o.tiendas
 * @param {Map<string, import('./tiendanube.js').TiendanubeAPI>} o.apis
 * @param {object} o.db   ver baseDeDatos.js
 * @param {{modoPrueba:boolean,prefijoPrueba:string,maxEscrituras:number}} o.cfg
 */
export async function sincronizar({ tiendas, apis, db, cfg }) {
  const resumen = { inicio: new Date().toISOString(), cambiosDetectados: 0, ajustes: 0, errores: [], sinPar: 0, pendientes: 0 };

  if (tiendas.length < 2) {
    resumen.errores.push({ error: 'Hacen falta al menos 2 tiendas configuradas' });
    return resumen;
  }

  const { fotos, errores } = await leerTodas(tiendas, apis);
  if (errores.length) {
    // Si no pudimos leer alguna tienda, no tocamos nada: sin la foto completa
    // no se puede calcular bien el cambio total. Se reintenta en la próxima.
    resumen.errores.push(...errores);
    return resumen;
  }

  const skus = new Set();
  for (const foto of fotos.values()) for (const sku of foto.keys()) skus.add(sku);

  let escrituras = 0;

  for (const sku of [...skus].sort()) {
    if (!skuPermitido(sku, cfg)) continue;

    // Qué tiendas participan para este SKU
    const participantes = [];
    for (const t of tiendas) {
      const item = fotos.get(t.id).get(sku);
      if (!item) continue;
      if (item.duplicado) {
        db.borrarBase(t.id, sku);
        db.anotarAviso(sku, t.id, 'sku_duplicado', 'El SKU está repetido en esta tienda; no se sincroniza');
        continue;
      }
      if (item.stock === null) {
        db.borrarBase(t.id, sku);
        continue; // stock infinito: no se controla
      }
      participantes.push({ t, item, base: db.leerBase(t.id, sku) });
    }

    if (participantes.length < 2) {
      // Sin par: solo actualizamos la base para que, si después aparece el
      // par, arranque desde cero sin "cambios" falsos.
      for (const p of participantes) {
        db.guardarBase(p.t.id, sku, { base: p.item.stock, pendiente: 0, item: p.item, sinPar: true });
      }
      resumen.sinPar++;
      continue;
    }

    for (const p of participantes) {
      if (!p.base) p.base = { base: p.item.stock, pendiente: 0 }; // recién emparejado
      p.d = p.item.stock - p.base.base;
    }
    const total = participantes.reduce((s, p) => s + p.d, 0);
    for (const p of participantes) p.v = total - p.d + (p.base.pendiente || 0);

    for (const p of participantes) {
      if (p.d !== 0) {
        resumen.cambiosDetectados++;
        db.anotarMovimiento({ sku, tienda: p.t.id, tipo: 'cambio_detectado', valor: p.d, detalle: `stock ${p.base.base} → ${p.item.stock}` });
      }
    }

    // Antes de escribir dejamos asentado lo que se debe, por si algo falla.
    for (const p of participantes) {
      db.guardarBase(p.t.id, sku, { base: p.item.stock, pendiente: p.v, item: p.item });
    }

    for (const p of participantes) {
      if (p.v === 0) continue;
      if (escrituras >= cfg.maxEscrituras) {
        resumen.pendientes++;
        continue; // queda pendiente para la próxima corrida
      }
      escrituras++;
      try {
        guardiaPrueba(sku, cfg);
        const quedo = await apis.get(p.t.id).ajustarStock(p.item.productoId, p.item.varianteId, p.v);
        const esperado = p.item.stock + p.v;
        let nuevaBase = esperado;
        if (esperado < 0) {
          // Tiendanube no deja stock negativo: lo deja en 0. Sobreventa.
          nuevaBase = quedo === null ? 0 : quedo;
          db.anotarMovimiento({ sku, tienda: p.t.id, tipo: 'sobreventa', valor: esperado, detalle: `Se vendió más de lo que había; quedó en ${nuevaBase}` });
        }
        db.guardarBase(p.t.id, sku, { base: nuevaBase, pendiente: 0, item: { ...p.item, stock: quedo ?? nuevaBase } });
        db.anotarMovimiento({ sku, tienda: p.t.id, tipo: 'ajuste', valor: p.v, detalle: `stock ${p.item.stock} → ${quedo ?? '?'}` });
        resumen.ajustes++;
      } catch (e) {
        resumen.errores.push({ tienda: p.t.id, sku, error: String(e.message || e) });
        db.anotarMovimiento({ sku, tienda: p.t.id, tipo: 'error', valor: p.v, detalle: String(e.message || e).slice(0, 300) });
        // la base ya quedó con el "pendiente": se reintenta solo
      }
    }
  }

  resumen.fin = new Date().toISOString();
  return resumen;
}

/**
 * Deja todas las tiendas con el stock de una tienda de referencia.
 * Se usa una sola vez al arrancar (o para corregir un descuadre).
 * Pisa el stock: conviene hacerlo en un horario sin ventas.
 */
export async function igualar({ tiendas, apis, db, cfg, referencia }) {
  const resumen = { inicio: new Date().toISOString(), igualados: 0, yaIguales: 0, faltan: 0, errores: [] };
  if (!tiendas.some((t) => t.id === referencia)) {
    resumen.errores.push({ error: `La tienda de referencia ${referencia} no está configurada` });
    return resumen;
  }
  const { fotos, errores } = await leerTodas(tiendas, apis);
  if (errores.length) {
    resumen.errores.push(...errores);
    return resumen;
  }
  const ref = fotos.get(referencia);
  let escrituras = 0;
  for (const [sku, itemRef] of [...ref.entries()].sort()) {
    if (!skuPermitido(sku, cfg) || itemRef.duplicado || itemRef.stock === null) continue;
    const objetivo = itemRef.stock;
    for (const t of tiendas) {
      if (t.id === referencia) continue;
      const item = fotos.get(t.id).get(sku);
      if (!item || item.duplicado || item.stock === null) continue;
      if (item.stock === objetivo) {
        db.guardarBase(t.id, sku, { base: objetivo, pendiente: 0, item });
        resumen.yaIguales++;
        continue;
      }
      if (escrituras >= cfg.maxEscrituras) {
        // No llegamos: queda con su stock actual como punto de partida y se
        // iguala la próxima vez que se apriete "Igualar".
        db.guardarBase(t.id, sku, { base: item.stock, pendiente: 0, item });
        resumen.faltan++;
        continue;
      }
      escrituras++;
      try {
        guardiaPrueba(sku, cfg);
        const quedo = await apis.get(t.id).reemplazarStock(item.productoId, item.varianteId, objetivo);
        db.guardarBase(t.id, sku, { base: quedo ?? objetivo, pendiente: 0, item: { ...item, stock: quedo ?? objetivo } });
        db.anotarMovimiento({ sku, tienda: t.id, tipo: 'igualado', valor: objetivo - item.stock, detalle: `stock ${item.stock} → ${objetivo} (referencia: ${referencia})` });
        resumen.igualados++;
      } catch (e) {
        db.guardarBase(t.id, sku, { base: item.stock, pendiente: 0, item });
        resumen.errores.push({ tienda: t.id, sku, error: String(e.message || e) });
      }
    }
    // La referencia siempre queda con su stock actual como base: así lo que
    // se igualó no vuelve a moverse en la próxima sincronización.
    db.guardarBase(referencia, sku, { base: objetivo, pendiente: 0, item: itemRef });
  }
  if (resumen.faltan) resumen.aviso = `Faltan ${resumen.faltan} variantes por igualar: apretá "Igualar" de nuevo`;
  resumen.fin = new Date().toISOString();
  return resumen;
}
