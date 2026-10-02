// Reemplaza el módulo 'cloudflare:workers' cuando probamos en Node.
export async function resolve(especificador, contexto, siguiente) {
  if (especificador === 'cloudflare:workers') {
    return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
  }
  return siguiente(especificador, contexto);
}
