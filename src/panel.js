// HTML del panel de administración. Sin dependencias, todo en una página.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function hora(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'medium' });
  } catch {
    return iso;
  }
}

const ETIQUETAS = {
  cambio_detectado: 'Cambio detectado',
  ajuste: 'Ajuste aplicado',
  igualado: 'Igualado',
  sobreventa: 'Sobreventa',
  error: 'Error',
  sku_duplicado: 'SKU duplicado',
  igualar: 'Igualar (resumen)',
  reinicio: 'Reinicio',
};

export function renderPanel(estado, resultado, { webhookConfigurado }) {
  const nombre = new Map(estado.tiendas.map((t) => [t.id, t.nombre]));
  const uc = estado.ultimaCorrida;

  // Agrupar bases por SKU
  const porSku = new Map();
  for (const b of estado.bases) {
    if (!porSku.has(b.sku)) porSku.set(b.sku, new Map());
    porSku.get(b.sku).set(b.tienda, b);
  }
  const filas = [...porSku.entries()].sort(([a], [b]) => a.localeCompare(b));

  const filasHtml = filas
    .map(([sku, m]) => {
      const algunaFila = [...m.values()][0];
      const stocks = estado.tiendas.map((t) => m.get(t.id)?.stock_visto).filter((x) => x !== undefined && x !== null);
      const sinPar = [...m.values()].some((b) => b.sin_par);
      const pendiente = [...m.values()].some((b) => b.pendiente);
      const distinto = !sinPar && new Set(stocks).size > 1;
      let marca = '<span class="ok">sincronizado</span>';
      if (sinPar) marca = '<span class="gris">sin par</span>';
      else if (pendiente) marca = '<span class="alerta">pendiente</span>';
      else if (distinto) marca = '<span class="alerta">stock distinto</span>';
      const celdas = estado.tiendas
        .map((t) => {
          const b = m.get(t.id);
          if (!b) return '<td class="num gris">—</td>';
          const p = b.pendiente ? ` <small class="alerta">(pend. ${b.pendiente > 0 ? '+' : ''}${b.pendiente})</small>` : '';
          return `<td class="num">${esc(b.stock_visto ?? '∞')}${p}</td>`;
        })
        .join('');
      return `<tr><td><code>${esc(sku)}</code></td><td>${esc(algunaFila?.nombre || '')}</td>${celdas}<td>${marca}</td></tr>`;
    })
    .join('');

  const movHtml = estado.movimientos
    .map(
      (m) => `<tr class="t-${esc(m.tipo)}"><td>${esc(hora(m.ts))}</td><td>${esc(ETIQUETAS[m.tipo] || m.tipo)}</td><td><code>${esc(m.sku || '')}</code></td>
      <td>${esc(nombre.get(m.tienda) || m.tienda || '')}</td><td class="num">${m.valor === null ? '' : esc((m.valor > 0 ? '+' : '') + m.valor)}</td><td>${esc(m.detalle || '')}</td></tr>`,
    )
    .join('');

  const opciones = estado.tiendas.map((t) => `<option value="${esc(t.id)}">${esc(t.nombre)} (${esc(t.id)})</option>`).join('');

  const avisos = [];
  if (estado.cfg.modoPrueba) avisos.push(`<div class="banda prueba">MODO PRUEBA: solo se tocan SKUs que empiezan con <code>${esc(estado.cfg.prefijoPrueba)}</code></div>`);
  else avisos.push('<div class="banda real">MODO REAL: se sincronizan todos los SKUs</div>');
  for (const p of estado.problemas) avisos.push(`<div class="banda error">${esc(p)}</div>`);
  if (estado.tiendas.length < 2) avisos.push('<div class="banda error">Hay menos de 2 tiendas configuradas. Cargá TIENDA_1_ID, TIENDA_1_TOKEN, TIENDA_2_ID y TIENDA_2_TOKEN en Cloudflare.</div>');
  if (!webhookConfigurado) avisos.push('<div class="banda alerta-b">Falta WEBHOOK_SECRETO: sin eso funciona igual, pero sincroniza una vez por minuto en lugar de al instante.</div>');

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sync Stock</title>
<style>
:root{--fondo:#f6f7f9;--carta:#fff;--texto:#1b1f24;--suave:#5b6470;--borde:#dfe3e8;--azul:#1a5fd6;--verde:#1d7a46;--naranja:#a85a00;--rojo:#b42318}
@media (prefers-color-scheme:dark){:root{--fondo:#111418;--carta:#1a1f25;--texto:#e7eaee;--suave:#9aa4b0;--borde:#2c333b;--azul:#6ea2ff;--verde:#4cc38a;--naranja:#f0a54a;--rojo:#ff7b72}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--fondo);color:var(--texto)}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 10px}
.sub{color:var(--suave);margin:0 0 16px}.carta{background:var(--carta);border:1px solid var(--borde);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.banda{padding:8px 12px;border-radius:8px;margin-bottom:8px;font-weight:600}.prueba{background:#fff4d6;color:#7a5200}.real{background:#dff5e8;color:#145c34}.error{background:#fde4e1;color:#8a1a10}.alerta-b{background:#eef3ff;color:#1b3f8f}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--borde);vertical-align:top}th{color:var(--suave);font-weight:600;font-size:12px}
.num{text-align:right;font-variant-numeric:tabular-nums}.ok{color:var(--verde)}.alerta{color:var(--naranja)}.gris{color:var(--suave)}
.t-error td,.t-sobreventa td{color:var(--rojo)}code{font-size:12px;white-space:nowrap}
.acciones{display:flex;flex-wrap:wrap;gap:8px;align-items:center}button{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid var(--borde);background:var(--carta);color:var(--texto);cursor:pointer}
button.prim{background:var(--azul);border-color:var(--azul);color:#fff}input,select{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid var(--borde);background:var(--carta);color:var(--texto)}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;margin:0}.tabla{overflow-x:auto}details summary{cursor:pointer;color:var(--suave)}
</style></head><body><main>
<h1>Sincronización de stock entre Tiendanube</h1>
<p class="sub">${estado.tiendas.map((t) => esc(`${t.nombre} (${t.id})`)).join(' ↔ ') || 'Sin tiendas'}</p>
${avisos.join('')}
${resultado ? `<div class="carta"><strong>${esc(resultado.titulo)}</strong><pre>${esc(JSON.stringify(resultado.datos, null, 2))}</pre></div>` : ''}

<div class="carta">
  <div><strong>Última corrida:</strong> ${esc(hora(uc?.inicio))} · motivo: ${esc(uc?.motivo || '—')} · cambios: ${esc(uc?.cambiosDetectados ?? 0)} · ajustes: ${esc(uc?.ajustes ?? 0)} · errores: ${esc(uc?.errores?.length ?? 0)}</div>
  ${uc?.errores?.length ? `<pre class="alerta">${esc(JSON.stringify(uc.errores, null, 2))}</pre>` : ''}
  <div class="acciones" style="margin-top:10px">
    <form method="post" action="/admin/sincronizar"><button class="prim">Sincronizar ahora</button></form>
    <form method="post" action="/admin/webhooks-registrar"><button>Registrar webhooks</button></form>
    <form method="post" action="/admin/webhooks-ver"><button>Ver webhooks</button></form>
    <a href="/admin"><button type="button">Actualizar</button></a>
  </div>
</div>

<h2>Stock por SKU</h2>
<div class="carta tabla"><table><thead><tr><th>SKU</th><th>Producto</th>${estado.tiendas.map((t) => `<th class="num">${esc(t.nombre)}</th>`).join('')}<th>Estado</th></tr></thead>
<tbody>${filasHtml || `<tr><td colspan="${estado.tiendas.length + 3}" class="gris">Todavía no hay datos. Apretá "Sincronizar ahora".</td></tr>`}</tbody></table></div>

<h2>Movimientos recientes</h2>
<div class="carta tabla"><table><thead><tr><th>Hora</th><th>Tipo</th><th>SKU</th><th>Tienda</th><th class="num">Cant.</th><th>Detalle</th></tr></thead>
<tbody>${movHtml || '<tr><td colspan="6" class="gris">Sin movimientos todavía</td></tr>'}</tbody></table></div>

<h2>Herramientas</h2>
<div class="carta">
  <details><summary>Igualar stock desde una tienda (pisa el stock de las demás)</summary>
  <p>Deja todas las tiendas con el mismo stock que la tienda elegida, SKU por SKU. Usalo una vez al arrancar, en un horario sin ventas.</p>
  <form method="post" action="/admin/igualar" class="acciones"><select name="referencia">${opciones}</select>
  <input name="confirmar" placeholder="Escribí IGUALAR" autocomplete="off"><button>Igualar</button></form></details>
</div>
<div class="carta">
  <details><summary>Reiniciar bases (no toca stock)</summary>
  <p>Borra lo que el sincronizador recuerda. La próxima corrida toma el stock actual como punto de partida, sin mover nada.</p>
  <form method="post" action="/admin/reiniciar" class="acciones"><input name="confirmar" placeholder="Escribí REINICIAR" autocomplete="off"><button>Reiniciar</button></form></details>
</div>
<div class="carta">
  <details><summary>Borrar los webhooks de esta app</summary>
  <form method="post" action="/admin/webhooks-borrar" class="acciones" style="margin-top:8px"><button>Borrar webhooks</button></form></details>
</div>
</main></body></html>`;
}
