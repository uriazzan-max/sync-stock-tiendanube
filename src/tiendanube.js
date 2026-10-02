// Cliente mínimo de la API de Tiendanube.
// Documentación: https://tiendanube.github.io/api-documentation/intro
//
// Solo usa lo que la sincronización necesita:
//   - leer todas las variantes con su SKU y stock
//   - ajustar stock por diferencia ("variation") o reemplazarlo ("replace")
//   - registrar / listar / borrar webhooks

export class ErrorAPI extends Error {
  constructor(status, cuerpo, ruta) {
    super(`Tiendanube respondió ${status} en ${ruta}: ${String(cuerpo).slice(0, 300)}`);
    this.status = status;
    this.cuerpo = cuerpo;
    this.ruta = ruta;
  }
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

export class TiendanubeAPI {
  /**
   * @param {object} o
   * @param {string} o.id        ID numérico de la tienda (store_id)
   * @param {string} o.token     Token de la aplicación a medida
   * @param {string} o.base      Ej: https://api.tiendanube.com/2025-03
   * @param {string} o.userAgent Tiendanube exige identificar la app
   * @param {Function} [o.fetchFn]
   */
  constructor({ id, token, base, userAgent, fetchFn }) {
    this.id = String(id).trim();
    this.token = String(token).trim();
    this.base = base.replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.fetchFn = fetchFn || ((...a) => fetch(...a));
    this.llamadas = 0;
  }

  async req(metodo, ruta, cuerpo) {
    const url = `${this.base}/${this.id}${ruta}`;
    let ultimoError;
    for (let intento = 0; intento < 4; intento++) {
      this.llamadas++;
      const res = await this.fetchFn(url, {
        method: metodo,
        headers: {
          // La documentación actual usa "Authorization: Bearer". Algunas
          // integraciones viejas usan "Authentication: bearer". Mandamos ambas.
          Authorization: `Bearer ${this.token}`,
          Authentication: `bearer ${this.token}`,
          'User-Agent': this.userAgent,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      });
      const texto = await res.text();
      if (res.status === 429 || res.status >= 500) {
        ultimoError = new ErrorAPI(res.status, texto, `${metodo} ${ruta}`);
        const reset = Number(res.headers.get('x-rate-limit-reset'));
        await esperar(Math.min(Number.isFinite(reset) && reset > 0 ? reset : 1000 * (intento + 1), 4000));
        continue;
      }
      if (!res.ok) throw new ErrorAPI(res.status, texto, `${metodo} ${ruta}`);
      return texto ? JSON.parse(texto) : null;
    }
    throw ultimoError;
  }

  /** Todas las variantes de la tienda (productos visibles y ocultos). */
  async listarVariantes() {
    const salida = [];
    const porPagina = 200;
    for (let pagina = 1; pagina <= 500; pagina++) {
      const productos = await this.req(
        'GET',
        `/products?page=${pagina}&per_page=${porPagina}&fields=id,name,variants`,
      );
      if (!Array.isArray(productos) || productos.length === 0) break;
      for (const p of productos) {
        const nombre = nombreTexto(p.name);
        for (const v of p.variants || []) {
          salida.push({
            productoId: p.id,
            varianteId: v.id,
            sku: v.sku,
            // stock null = stock infinito (Tiendanube no lo controla)
            stock: v.stock === null || v.stock === undefined || v.stock === '' ? null : Number(v.stock),
            nombre: nombre + textoValores(v.values),
          });
        }
      }
      if (productos.length < porPagina) break;
    }
    return salida;
  }

  /** Suma o resta stock a una variante. Devuelve el stock que quedó. */
  async ajustarStock(productoId, varianteId, valor) {
    const r = await this.req('POST', `/products/${productoId}/variants/stock`, {
      action: 'variation',
      value: valor,
      id: varianteId,
    });
    return stockDe(r, varianteId);
  }

  /** Pisa el stock de una variante. Devuelve el stock que quedó. */
  async reemplazarStock(productoId, varianteId, valor) {
    const r = await this.req('POST', `/products/${productoId}/variants/stock`, {
      action: 'replace',
      value: valor,
      id: varianteId,
    });
    return stockDe(r, varianteId);
  }

  listarWebhooks() {
    return this.req('GET', '/webhooks?per_page=200');
  }
  crearWebhook(evento, url) {
    return this.req('POST', '/webhooks', { event: evento, url });
  }
  borrarWebhook(id) {
    return this.req('DELETE', `/webhooks/${id}`);
  }
}

function stockDe(respuesta, varianteId) {
  const lista = Array.isArray(respuesta) ? respuesta : [respuesta];
  const v = lista.find((x) => x && String(x.id) === String(varianteId)) || lista[0];
  if (!v || v.stock === null || v.stock === undefined) return null;
  return Number(v.stock);
}

function nombreTexto(n) {
  if (!n) return '';
  if (typeof n === 'string') return n;
  return n.es || n.pt || n.en || Object.values(n)[0] || '';
}

function textoValores(valores) {
  if (!Array.isArray(valores) || valores.length === 0) return '';
  const partes = valores.map(nombreTexto).filter(Boolean);
  return partes.length ? ` (${partes.join(' / ')})` : '';
}
