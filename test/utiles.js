// Utilidades de prueba: una tienda Tiendanube simulada y SQLite en memoria
// con la misma forma que ctx.storage.sql de Cloudflare.

import { DatabaseSync } from 'node:sqlite';
import { BaseDeDatos } from '../src/baseDeDatos.js';

export class SqlFalso {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.escrituras = 0;
  }
  exec(query, ...params) {
    const q = query.trim();
    if (/^(INSERT|UPDATE|DELETE)/i.test(q)) this.escrituras++;
    if (/^(CREATE)/i.test(q)) {
      this.db.exec(q);
      return { toArray: () => [] };
    }
    const st = this.db.prepare(q);
    if (/^SELECT/i.test(q)) {
      const filas = st.all(...params).map((f) => ({ ...f }));
      return { toArray: () => filas };
    }
    st.run(...params);
    return { toArray: () => [] };
  }
}

export function nuevaDb() {
  const sql = new SqlFalso();
  return { db: new BaseDeDatos(sql), sql };
}

let proximoId = 1000;

/** Tienda simulada con la misma interfaz que TiendanubeAPI. */
export class TiendaFalsa {
  constructor(nombre, variantes) {
    this.nombre = nombre;
    this.variantes = variantes.map((v) => ({ productoId: proximoId++, varianteId: proximoId++, nombre: v.sku, ...v }));
    this.escrituras = [];
    this.fallarLectura = false;
    this.fallarEscrituras = 0;
    this.antesDeEscribir = null; // para simular ventas que entran en el medio
  }
  stock(sku) {
    return this.variantes.find((v) => v.sku === sku)?.stock;
  }
  vender(sku, n = 1) {
    const v = this.variantes.find((x) => x.sku === sku);
    v.stock = Math.max(0, v.stock - n);
  }
  sumar(sku, n) {
    const v = this.variantes.find((x) => x.sku === sku);
    v.stock += n;
  }
  async listarVariantes() {
    if (this.fallarLectura) throw new Error(`${this.nombre}: no responde`);
    return this.variantes.map((v) => ({ ...v }));
  }
  _buscar(p, id) {
    const v = this.variantes.find((x) => x.varianteId === id && x.productoId === p);
    if (!v) throw new Error('variante inexistente');
    return v;
  }
  async ajustarStock(p, id, valor) {
    if (this.antesDeEscribir) {
      const f = this.antesDeEscribir;
      this.antesDeEscribir = null;
      f();
    }
    if (this.fallarEscrituras > 0) {
      this.fallarEscrituras--;
      throw new Error(`${this.nombre}: error 500`);
    }
    const v = this._buscar(p, id);
    v.stock = Math.max(0, v.stock + valor); // Tiendanube no deja stock negativo
    this.escrituras.push({ sku: v.sku, accion: 'variation', valor });
    return v.stock;
  }
  async reemplazarStock(p, id, valor) {
    const v = this._buscar(p, id);
    v.stock = valor;
    this.escrituras.push({ sku: v.sku, accion: 'replace', valor });
    return v.stock;
  }
}

export function armar(tiendasFalsas, cfg = {}) {
  const tiendas = tiendasFalsas.map((t, i) => ({ id: String(i + 1), nombre: t.nombre }));
  const apis = new Map(tiendasFalsas.map((t, i) => [String(i + 1), t]));
  const { db, sql } = nuevaDb();
  return { tiendas, apis, db, sql, cfg: { modoPrueba: true, prefijoPrueba: 'TEST-', maxEscrituras: 25, ...cfg } };
}
