// Punto de entrada del Worker de Cloudflare.
//
//   /webhook/<WEBHOOK_SECRETO>  Tiendanube avisa de ventas y cambios (empujón)
//   /admin                      Panel (usuario cualquiera, clave = ADMIN_CLAVE)
//   cron cada minuto            Sincronización completa (red de seguridad)
//
// Todo el trabajo pasa por un único Durable Object ("Sincronizador"), así
// nunca corren dos sincronizaciones a la vez.

import { DurableObject } from 'cloudflare:workers';
import { BaseDeDatos } from './baseDeDatos.js';
import { leerConfig, crearApis } from './config.js';
import { sincronizar, igualar } from './motor.js';
import { renderPanel } from './panel.js';

const EVENTOS_WEBHOOK = ['order/created', 'order/paid', 'order/cancelled', 'order/edited', 'product/updated'];

export class Sincronizador extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.db = new BaseDeDatos(ctx.storage.sql);
    this.cola = Promise.resolve();
    this.corridaEnCola = null;
  }

  // Ejecuta tareas de a una, en orden.
  _enSerie(fn) {
    const p = this.cola.then(fn, fn);
    this.cola = p.catch(() => {});
    return p;
  }

  _contexto() {
    const { tiendas, problemas, cfg, apiBase } = leerConfig(this.env);
    return { tiendas, problemas, cfg, apis: crearApis(tiendas, apiBase), db: this.db };
  }

  /** Sincroniza ya. Varios pedidos seguidos se juntan en una sola corrida. */
  correr(motivo = 'manual') {
    if (this.corridaEnCola) return this.corridaEnCola;
    const p = this._enSerie(async () => {
      this.corridaEnCola = null;
      const c = this._contexto();
      let r;
      try {
        r = await sincronizar(c);
      } catch (e) {
        r = { errores: [{ error: String(e.stack || e) }] };
      }
      r.motivo = motivo;
      if (c.problemas.length) r.errores = [...(r.errores || []), ...c.problemas.map((error) => ({ error }))];
      this.db.guardarAjuste('ultima_corrida', r);
      if (r.ajustes || r.errores?.length) this.db.guardarAjuste('ultima_corrida_con_actividad', r);
      return r;
    });
    this.corridaEnCola = p;
    return p;
  }

  /** Empujón desde un webhook: corre en ~2 segundos (junta avisos seguidos). */
  async avisar() {
    const alarma = await this.ctx.storage.getAlarm();
    if (!alarma) await this.ctx.storage.setAlarm(Date.now() + 2000);
  }

  async alarm() {
    await this.correr('webhook');
  }

  igualarDesde(referencia) {
    return this._enSerie(async () => {
      const r = await igualar({ ...this._contexto(), referencia });
      this.db.anotarMovimiento({ tipo: 'igualar', detalle: JSON.stringify(r).slice(0, 500) });
      return r;
    });
  }

  reiniciarBases() {
    return this._enSerie(async () => {
      this.db.reiniciarBases();
      this.db.anotarMovimiento({ tipo: 'reinicio', detalle: 'Se borraron las bases; la próxima corrida arranca de cero sin mover stock' });
      return { ok: true };
    });
  }

  estado() {
    const { tiendas, problemas, cfg } = leerConfig(this.env);
    return {
      tiendas: tiendas.map(({ n, id, nombre }) => ({ n, id, nombre })),
      problemas,
      cfg,
      ultimaCorrida: this.db.leerAjuste('ultima_corrida'),
      ultimaConActividad: this.db.leerAjuste('ultima_corrida_con_actividad'),
      bases: this.db.listarBases(),
      movimientos: this.db.ultimosMovimientos(150),
    };
  }

  async webhooks(accion, urlWebhook) {
    const { tiendas, apis } = this._contexto();
    const salida = [];
    for (const t of tiendas) {
      const api = apis.get(t.id);
      try {
        const existentes = (await api.listarWebhooks()) || [];
        if (accion === 'ver') {
          salida.push({ tienda: t.nombre, webhooks: existentes.map((w) => `${w.event} → ${ocultarSecreto(w.url)}`) });
        } else if (accion === 'registrar') {
          const hechos = [];
          for (const ev of EVENTOS_WEBHOOK) {
            if (existentes.some((w) => w.event === ev && w.url === urlWebhook)) {
              hechos.push(`${ev}: ya estaba`);
              continue;
            }
            try {
              await api.crearWebhook(ev, urlWebhook);
              hechos.push(`${ev}: registrado`);
            } catch (e) {
              hechos.push(`${ev}: ERROR ${e.message}`);
            }
          }
          salida.push({ tienda: t.nombre, webhooks: hechos });
        } else if (accion === 'borrar') {
          const propios = existentes.filter((w) => String(w.url).startsWith(new URL(urlWebhook).origin));
          for (const w of propios) await api.borrarWebhook(w.id);
          salida.push({ tienda: t.nombre, webhooks: [`${propios.length} borrados`] });
        }
      } catch (e) {
        salida.push({ tienda: t.nombre, webhooks: [`ERROR: ${e.message}`] });
      }
    }
    return salida;
  }
}

function ocultarSecreto(url) {
  return String(url).replace(/\/webhook\/[^/?#]+/, '/webhook/•••');
}

function sincronizador(env) {
  return env.SINCRONIZADOR.get(env.SINCRONIZADOR.idFromName('principal'));
}

function igualSeguro(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

function autorizado(request, env) {
  const h = request.headers.get('Authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decodificado = '';
  try {
    decodificado = atob(h.slice(6));
  } catch {
    return false;
  }
  const clave = decodificado.slice(decodificado.indexOf(':') + 1);
  return igualSeguro(clave, env.ADMIN_CLAVE);
}

const html = (cuerpo, status = 200) =>
  new Response(cuerpo, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const ruta = url.pathname.replace(/\/+$/, '') || '/';

    // 1) Webhooks de Tiendanube: solo un "empujón". No confiamos en el
    //    contenido: el motor siempre relee el stock real desde la API.
    if (ruta.startsWith('/webhook/')) {
      const secreto = ruta.slice('/webhook/'.length);
      if (!env.WEBHOOK_SECRETO || !igualSeguro(secreto, env.WEBHOOK_SECRETO)) return new Response('no', { status: 404 });
      ctx.waitUntil(sincronizador(env).avisar());
      return new Response('ok');
    }

    // 2) Panel de administración
    if (ruta === '/admin' || ruta.startsWith('/admin/')) {
      if (!env.ADMIN_CLAVE) return html('<p>Falta configurar el secreto ADMIN_CLAVE en Cloudflare.</p>', 503);
      if (!autorizado(request, env)) {
        return new Response('Clave requerida', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="Sync Stock", charset="UTF-8"' } });
      }
      const s = sincronizador(env);
      const urlWebhook = env.WEBHOOK_SECRETO ? `${url.origin}/webhook/${env.WEBHOOK_SECRETO}` : null;
      let resultado = null;

      if (request.method === 'POST') {
        const form = await request.formData();
        const accion = ruta.slice('/admin/'.length);
        if (accion === 'sincronizar') {
          resultado = { titulo: 'Sincronización manual', datos: await s.correr('manual') };
        } else if (accion === 'igualar') {
          if (form.get('confirmar') !== 'IGUALAR') {
            resultado = { titulo: 'Igualar stock', datos: { error: 'Para igualar tenés que escribir IGUALAR en el casillero' } };
          } else {
            resultado = { titulo: 'Igualar stock', datos: await s.igualarDesde(String(form.get('referencia'))) };
          }
        } else if (accion === 'reiniciar') {
          resultado =
            form.get('confirmar') === 'REINICIAR'
              ? { titulo: 'Reiniciar bases', datos: await s.reiniciarBases() }
              : { titulo: 'Reiniciar bases', datos: { error: 'Escribí REINICIAR para confirmar' } };
        } else if (accion.startsWith('webhooks-')) {
          if (!urlWebhook) {
            resultado = { titulo: 'Webhooks', datos: { error: 'Falta configurar el secreto WEBHOOK_SECRETO en Cloudflare' } };
          } else {
            resultado = { titulo: 'Webhooks', datos: await s.webhooks(accion.slice('webhooks-'.length), urlWebhook) };
          }
        }
      }

      const estado = await s.estado();
      if (ruta === '/admin/estado.json') return Response.json(estado);
      return html(renderPanel(estado, resultado, { webhookConfigurado: Boolean(urlWebhook) }));
    }

    if (ruta === '/') return new Response('Sync Stock Tiendanube funcionando. Panel en /admin');
    return new Response('No encontrado', { status: 404 });
  },

  // Red de seguridad: aunque no lleguen webhooks, cada minuto se sincroniza.
  async scheduled(_evento, env, ctx) {
    ctx.waitUntil(sincronizador(env).correr('cron'));
  },
};
