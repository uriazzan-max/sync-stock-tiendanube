# Sincronización de stock entre Tiendanube

Mantiene el stock igual entre dos o más tiendas Tiendanube, emparejando las variantes por **SKU**. Una venta, una cancelación o una carga manual en cualquier tienda se refleja en las demás.

- **Casi al instante** cuando llegan los avisos (webhooks) de Tiendanube.
- **Cada minuto** igual revisa todo, por si algún aviso no llega.
- **Modo prueba** activado por defecto: solo toca SKUs que empiezan con `TEST-`.

## Cómo funciona

El sincronizador recuerda, para cada SKU y cada tienda, el último stock que ya contabilizó (la "base"). En cada pasada lee el stock actual de todas las tiendas y calcula cuánto cambió cada una. A cada tienda le aplica **los cambios de las demás**, sumando o restando (nunca copia el stock entero). Por eso:

- No hay eco ni bucles: un ajuste hecho por la app ya queda contabilizado.
- Dos ventas casi simultáneas en tiendas distintas no se pisan.
- Si un ajuste falla, queda "pendiente" y se reintenta solo en la próxima pasada.
- Si no se puede leer alguna tienda, esa pasada no toca nada.

Se ignoran siempre: variantes sin SKU, SKUs repetidos dentro de una misma tienda, variantes con stock infinito y productos que existen en una sola tienda.

## Puesta en marcha (Cloudflare)

### 1. Conectar este repositorio

1. Entrá a [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Import a repository**.
2. Conectá GitHub y elegí `sync-stock-tiendanube`.
3. Dejá todo como viene (el comando de deploy es `npx wrangler deploy`) y tocá **Deploy**.
4. Al terminar, Cloudflare te da una dirección del tipo `https://sync-stock-tiendanube.<tu-cuenta>.workers.dev`.

Cada vez que se sube un cambio a GitHub, Cloudflare lo publica solo.

### 2. Cargar los secretos

En el Worker: **Settings** → **Variables and Secrets** → **Add**. Cargá cada uno con tipo **Secret** (así no se ven y no se pisan en cada deploy):

| Nombre | Valor |
| --- | --- |
| `TIENDA_1_ID` | Número de la tienda A (store ID, solo números) |
| `TIENDA_1_TOKEN` | Token de la aplicación a medida de la tienda A |
| `TIENDA_1_NOMBRE` | Opcional, ej. `Prueba A` |
| `TIENDA_2_ID` | Número de la tienda B |
| `TIENDA_2_TOKEN` | Token de la tienda B |
| `TIENDA_2_NOMBRE` | Opcional, ej. `Prueba B` |
| `ADMIN_CLAVE` | Una clave para entrar al panel (letras y números) |
| `WEBHOOK_SECRETO` | Una cadena larga al azar, ej. 30 letras y números |

Para más tiendas: `TIENDA_3_ID`, `TIENDA_3_TOKEN`, etc. Todas las tiendas configuradas se sincronizan entre sí.

Los tokens **nunca** van en el código ni en el chat.

### 3. Probar

1. Entrá a `https://<tu-worker>.workers.dev/admin` (usuario: cualquiera; clave: `ADMIN_CLAVE`).
2. **Sincronizar ahora**: la primera pasada solo toma el punto de partida, no mueve stock.
3. **Registrar webhooks**: pide a Tiendanube que avise de cada venta. Si da error, igual funciona con la revisión de cada minuto.
4. Si las tiendas arrancan con stock distinto: **Herramientas → Igualar stock** desde la tienda que tiene el stock correcto.
5. Hacé una compra de prueba en una tienda y mirá cómo baja en la otra (tabla "Stock por SKU" y "Movimientos recientes").

### 4. Pasar a las tiendas reales

1. Cambiar los secretos `TIENDA_1_*` y `TIENDA_2_*` por los de Hydra y For You Audaz.
2. Revisar en el panel que los SKUs aparezcan emparejados ("sincronizado") y no "sin par".
3. **Apagar Astroselling el mismo momento** en que se pasa a modo real (si no, cada venta se descuenta dos veces).
4. En `wrangler.toml` cambiar `MODO_PRUEBA = "false"` y subir el cambio.
5. Si hace falta, **Igualar** desde la tienda con el stock correcto, en un horario sin ventas.

## Variables de `wrangler.toml`

| Variable | Por defecto | Qué hace |
| --- | --- | --- |
| `MODO_PRUEBA` | `"true"` | Solo sincroniza SKUs con el prefijo de prueba |
| `PREFIJO_PRUEBA` | `"TEST-"` | Prefijo de los SKUs de prueba |
| `MAX_ESCRITURAS` | `"25"` | Máximo de ajustes por pasada (el resto sigue en la próxima) |
| `API_BASE` | `https://api.tiendanube.com/2025-03` | Versión de la API de Tiendanube |

## Límites y riesgos conocidos

| Riesgo | Nivel | Detalle |
| --- | --- | --- |
| Plan gratuito de Cloudflare con catálogos grandes | Medio | El plan gratis permite ~10 ms de CPU y 50 llamadas por ejecución. Alcanza para las tiendas de prueba; para Hydra conviene el plan Workers Paid (USD 5/mes) |
| Tiendas con "Múltiples depósitos" de Tiendanube | Medio | No está probado. Si una tienda usa varios depósitos, hay que verificarlo antes de pasar a real |
| Webhooks con token de app a medida | Bajo | No está confirmado que Tiendanube los permita; si no, la revisión de cada minuto cubre |
| Corte justo después de un ajuste | Bajo | Si Cloudflare se corta entre el ajuste y el registro, ese ajuste podría repetirse una vez. Muy improbable; queda en el registro de movimientos |
| Igualar pisa el stock | Bajo | Una venta que entra justo mientras se iguala se pierde. Igualar en horario sin ventas |

## Desarrollo

```bash
npm test     # 29 pruebas: motor, cliente de la API y el Worker de punta a punta
```

`src/motor.js` tiene toda la lógica; `src/index.js` el Worker y el Durable Object; `src/panel.js` el panel; `src/tiendanube.js` el cliente de la API.
