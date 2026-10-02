// Base de datos del sincronizador (SQLite dentro del Durable Object).
//
// Las bases se mantienen en memoria y solo se escriben en SQLite cuando
// cambian. Así, una corrida por minuto sin ventas no gasta escrituras
// (el plan gratuito de Cloudflare permite 100.000 filas escritas por día).

const MAX_MOVIMIENTOS = 5000;

export class BaseDeDatos {
  /** @param {{exec: Function}} sql  ctx.storage.sql del Durable Object */
  constructor(sql) {
    this.sql = sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS bases (
      tienda TEXT NOT NULL,
      sku TEXT NOT NULL,
      base INTEGER NOT NULL,
      pendiente INTEGER NOT NULL DEFAULT 0,
      stock_visto INTEGER,
      producto_id TEXT,
      variante_id TEXT,
      nombre TEXT,
      sin_par INTEGER NOT NULL DEFAULT 0,
      actualizado TEXT,
      PRIMARY KEY (tienda, sku)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS movimientos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      sku TEXT,
      tienda TEXT,
      tipo TEXT NOT NULL,
      valor INTEGER,
      detalle TEXT
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ajustes (k TEXT PRIMARY KEY, v TEXT)`);
    // Enlaces manuales o importados: variantes del mismo "grupo" se sincronizan
    // entre sí aunque su SKU no coincida.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS enlaces (
      tienda TEXT NOT NULL,
      variante_id TEXT NOT NULL,
      grupo TEXT NOT NULL,
      nota TEXT,
      PRIMARY KEY (tienda, variante_id)
    )`);
    this.cache = null;
    this.enlacesCache = null;
    this.avisados = new Set();
  }

  _clave(tienda, sku) {
    return `${tienda}\u0000${sku}`;
  }

  _cargar() {
    if (this.cache) return;
    this.cache = new Map();
    for (const f of this.sql.exec('SELECT * FROM bases').toArray()) {
      this.cache.set(this._clave(f.tienda, f.sku), f);
    }
  }

  leerBase(tienda, sku) {
    this._cargar();
    const f = this.cache.get(this._clave(tienda, sku));
    return f ? { base: f.base, pendiente: f.pendiente } : null;
  }

  guardarBase(tienda, sku, { base, pendiente = 0, item = {}, sinPar = false }) {
    this._cargar();
    const nueva = {
      tienda,
      sku,
      base,
      pendiente,
      stock_visto: item.stock ?? null,
      producto_id: item.productoId != null ? String(item.productoId) : null,
      variante_id: item.varianteId != null ? String(item.varianteId) : null,
      nombre: item.nombre ?? null,
      sin_par: sinPar ? 1 : 0,
    };
    const vieja = this.cache.get(this._clave(tienda, sku));
    if (vieja && ['base', 'pendiente', 'stock_visto', 'producto_id', 'variante_id', 'nombre', 'sin_par'].every((k) => vieja[k] === nueva[k])) {
      return; // sin cambios: no escribimos
    }
    nueva.actualizado = new Date().toISOString();
    this.sql.exec(
      `INSERT INTO bases (tienda, sku, base, pendiente, stock_visto, producto_id, variante_id, nombre, sin_par, actualizado)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tienda, sku) DO UPDATE SET base = excluded.base, pendiente = excluded.pendiente,
         stock_visto = excluded.stock_visto, producto_id = excluded.producto_id, variante_id = excluded.variante_id,
         nombre = excluded.nombre, sin_par = excluded.sin_par, actualizado = excluded.actualizado`,
      tienda, sku, nueva.base, nueva.pendiente, nueva.stock_visto, nueva.producto_id, nueva.variante_id, nueva.nombre, nueva.sin_par, nueva.actualizado,
    );
    this.cache.set(this._clave(tienda, sku), nueva);
  }

  borrarBase(tienda, sku) {
    this._cargar();
    const k = this._clave(tienda, sku);
    if (!this.cache.has(k)) return;
    this.sql.exec('DELETE FROM bases WHERE tienda = ? AND sku = ?', tienda, sku);
    this.cache.delete(k);
  }

  anotarMovimiento({ sku = null, tienda = null, tipo, valor = null, detalle = null }) {
    this.sql.exec(
      'INSERT INTO movimientos (ts, sku, tienda, tipo, valor, detalle) VALUES (?, ?, ?, ?, ?, ?)',
      new Date().toISOString(), sku, tienda, tipo, valor, detalle,
    );
    // recorte ocasional para que la tabla no crezca sin límite
    if (Math.random() < 0.02) {
      this.sql.exec('DELETE FROM movimientos WHERE id <= (SELECT MAX(id) FROM movimientos) - ?', MAX_MOVIMIENTOS);
    }
  }

  /** Avisos repetitivos (ej. SKU duplicado): se anotan una vez por arranque. */
  anotarAviso(sku, tienda, tipo, detalle) {
    const k = `${tipo}|${tienda}|${sku}`;
    if (this.avisados.has(k)) return;
    this.avisados.add(k);
    this.anotarMovimiento({ sku, tienda, tipo, detalle });
  }

  listarBases() {
    this._cargar();
    return [...this.cache.values()];
  }

  ultimosMovimientos(n = 200) {
    return this.sql.exec('SELECT * FROM movimientos ORDER BY id DESC LIMIT ?', n).toArray();
  }

  leerAjuste(k) {
    const f = this.sql.exec('SELECT v FROM ajustes WHERE k = ?', k).toArray()[0];
    return f ? JSON.parse(f.v) : null;
  }

  guardarAjuste(k, v) {
    this.sql.exec('INSERT INTO ajustes (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  /** Map "tienda:varianteId" → grupo (en memoria; se recarga si cambia). */
  mapaEnlaces() {
    if (!this.enlacesCache) {
      this.enlacesCache = new Map();
      for (const f of this.sql.exec('SELECT tienda, variante_id, grupo FROM enlaces').toArray()) {
        this.enlacesCache.set(`${f.tienda}:${f.variante_id}`, f.grupo);
      }
    }
    return this.enlacesCache;
  }

  /** Cantidad de grupos (un grupo = una variante enlazada entre tiendas). */
  contarEnlaces() {
    return this.sql.exec('SELECT COUNT(DISTINCT grupo) AS n FROM enlaces').toArray()[0]?.n ?? 0;
  }

  listarEnlaces() {
    return this.sql.exec('SELECT * FROM enlaces ORDER BY grupo, tienda').toArray();
  }

  /**
   * Guarda enlaces. Cada grupo es una lista de {tienda, varianteId}.
   * Una variante pertenece a un solo grupo: si ya estaba enlazada, se mueve.
   * @param {{grupo?:string, nota?:string, miembros:{tienda:string, varianteId:string}[]}[]} grupos
   */
  guardarEnlaces(grupos) {
    let n = 0;
    for (const g of grupos) {
      if (!g.miembros || g.miembros.length < 2) continue;
      const grupo = String(g.grupo || `${g.miembros[0].tienda}-${g.miembros[0].varianteId}`);
      for (const m of g.miembros) {
        this.sql.exec(
          `INSERT INTO enlaces (tienda, variante_id, grupo, nota) VALUES (?, ?, ?, ?)
           ON CONFLICT (tienda, variante_id) DO UPDATE SET grupo = excluded.grupo, nota = excluded.nota`,
          String(m.tienda), String(m.varianteId), grupo, g.nota ?? null,
        );
      }
      n++;
    }
    this.enlacesCache = null;
    return n;
  }

  borrarEnlaces() {
    this.sql.exec('DELETE FROM enlaces');
    this.enlacesCache = null;
  }

  /** Borra todas las bases (para empezar de cero). No toca stock. */
  reiniciarBases() {
    this.sql.exec('DELETE FROM bases');
    this.cache = new Map();
  }
}
