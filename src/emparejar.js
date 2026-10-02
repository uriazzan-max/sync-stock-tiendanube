// Cómo se decide qué variante de una tienda va con cuál de otra.
//
// Cada variante recibe una "clave". Las variantes con la misma clave en
// distintas tiendas se sincronizan entre sí. La clave sale, en este orden, de:
//
//   1. Un ENLACE guardado (variante X de la tienda 1 = variante Y de la
//      tienda 2). Sirve para importar los enlaces de Astroselling o unir a
//      mano productos cuyo SKU no coincide.
//   2. La regla automática, según EMPAREJAR:
//        "sku"           el SKU de la variante (cada variante con su SKU propio)
//        "sku+variante"  SKU + valores de la variante (color, talle...).
//                        Para tiendas donde todas las variantes de un producto
//                        comparten el mismo SKU. No distingue mayúsculas ni
//                        acentos, ni el orden de las propiedades.
//
//   En modo "sku+variante" cada tienda puede usar otra "clave de producto"
//   (TIENDA_n_CLAVE): "sku" (por defecto) o "nombre" del producto. Ej.: en
//   Hydra el SKU es el nombre que el producto tiene en For You Audaz.

export const MODOS = ['sku', 'sku+variante'];

export function normalizarSku(sku) {
  if (sku === null || sku === undefined) return '';
  return String(sku).trim();
}

/** "  Marrón   con Marrón " → "marron con marron" */
export function normalizarTexto(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function claveEnlace(tienda, varianteId) {
  return `${tienda}:${varianteId}`;
}

/**
 * @param {{sku:string, varianteId:any, valores?:string[]}} v
 * @param {string} tienda
 * @param {{modo?:string, enlaces?:Map<string,string>}} [empareja]
 * @returns {string} '' si la variante no se puede emparejar
 */
export function claveDe(v, tienda, empareja = {}) {
  const grupo = empareja.enlaces?.get(claveEnlace(tienda, v.varianteId));
  if (grupo) return `enlace:${grupo}`;
  const sku = normalizarSku(v.sku);
  if (empareja.modo === 'sku+variante') {
    const porNombre = empareja.claveProducto?.[tienda] === 'nombre';
    const base = normalizarTexto(porNombre ? v.producto : sku);
    if (!base) return '';
    const valores = (v.valores || []).map(normalizarTexto).filter(Boolean).sort();
    return valores.length ? `${base} · ${valores.join(' / ')}` : base;
  }
  return sku;
}

/**
 * Lee enlaces escritos como texto, uno por línea:
 *
 *   8319495:1172139657 = 8319532:2233445566   # Gamulan Almendra S
 *
 * Cada lado es "idDeTienda:idDeVariante". Se pueden separar con "=", "," o ";",
 * y unir más de dos tiendas en la misma línea. Lo que sigue a "#" es una nota.
 */
export function parsearEnlaces(texto, tiendasValidas) {
  const validas = new Set(tiendasValidas.map(String));
  const grupos = [];
  const errores = [];
  String(texto || '')
    .split(/\r?\n/)
    .forEach((linea, i) => {
      const [datos, ...resto] = linea.split('#');
      const nota = resto.join('#').trim() || null;
      if (!datos.trim()) return;
      const partes = datos.split(/[=,;]/).map((x) => x.trim()).filter(Boolean);
      const miembros = [];
      for (const p of partes) {
        const m = p.match(/^(\d+)\s*:\s*(\d+)$/);
        if (!m) {
          errores.push(`Línea ${i + 1}: "${p}" no tiene la forma tienda:variante`);
          return;
        }
        if (!validas.has(m[1])) {
          errores.push(`Línea ${i + 1}: la tienda ${m[1]} no está configurada`);
          return;
        }
        miembros.push({ tienda: m[1], varianteId: m[2] });
      }
      if (new Set(miembros.map((m) => m.tienda)).size !== miembros.length || miembros.length < 2) {
        errores.push(`Línea ${i + 1}: hacen falta al menos 2 tiendas distintas`);
        return;
      }
      grupos.push({ miembros, nota });
    });
  return { grupos, errores };
}
