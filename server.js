// ═══════════════════════════════════════════════════════════════════════════
// BELAVITA AI PROXY
// Puente seguro entre el frontend de Belavita Ops y la API de Anthropic.
//
// POR QUÉ EXISTE: antes la API key de Anthropic estaba escrita en el index.html,
// que se sirve al navegador → cualquiera podía copiarla. Ahora la key vive SOLO
// acá, como variable de entorno de Railway. El frontend nunca la ve.
//
// SEGURIDAD: no es un proxy abierto. Antes de reenviar cada pedido a Anthropic,
// valida el token de sesión de Supabase que manda el frontend. Si no sos un
// usuario logueado de Belavita, te rechaza (401). Además solo permite los
// modelos esperados y le pone tope a max_tokens, para que un token robado no
// pueda disparar trabajos gigantes.
//
// ── QUÉ SE AGREGÓ (19/09/2026) ──
//
//  1 · EL TOPE VIVE ACÁ. Antes lo miraba la pantalla, y una pantalla se puede
//      saltear abriendo la consola. Ahora, antes de cada llamada, se le
//      pregunta a la base si queda presupuesto del día; si no queda, no se
//      llama a Anthropic y se devuelve 429 con el motivo.
//
//  2 · CADA LLAMADA QUEDA ANOTADA con sus tokens y su costo, del lado del
//      servidor, que es donde nadie puede falsearla.
//
//  3 · EL ASISTENTE TIENE HERRAMIENTAS. La ruta /asistente le da a Claude
//      funciones para CONSULTAR los datos del negocio —stock, ventas, lo que
//      falta comprar, socios— en vez de mandarle un resumen armado de
//      antemano. Claude pide la herramienta, este servidor la ejecuta contra
//      Supabase y le devuelve el resultado.
//
//      Todas las herramientas de esta versión son de LECTURA. Todavía no hay
//      ninguna que escriba: primero que consulte bien, después que toque.
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const PORT              = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;   // la key NUEVA (no la filtrada)
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;   // anon key (sirve para validar tokens)
// La llave de servicio: solo para las herramientas y para anotar el gasto.
// Sin ella el asistente sigue funcionando, pero sin poder consultar nada.
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || '*';
const MODELOS_OK        = (process.env.MODELOS_OK ||
  'claude-sonnet-4-6,claude-sonnet-5,claude-haiku-4-5').split(',').map(s => s.trim());
// El que usa el asistente si el frontend no pide otro. sonnet-5 cuesta un
// tercio menos que sonnet-4-6 por el mismo trabajo.
const MODELO_ASISTENTE  = process.env.MODELO_ASISTENTE || 'claude-sonnet-5';
const MAX_TOKENS_TOPE   = parseInt(process.env.MAX_TOKENS_TOPE || '2000', 10);
// Cuántas vueltas de herramientas como máximo en una consulta. Cada vuelta es
// una llamada paga: sin este número, una pregunta rara puede volverse cara.
const MAX_VUELTAS       = parseInt(process.env.MAX_VUELTAS || '5', 10);

if (!ANTHROPIC_API_KEY) { console.error('✗ Falta ANTHROPIC_API_KEY. Cortando.'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('✗ Falta SUPABASE_URL o SUPABASE_ANON_KEY. Cortando.'); process.exit(1); }
if (!SUPABASE_SERVICE_KEY) {
  console.warn('⚠ Falta SUPABASE_SERVICE_KEY: el asistente no va a poder consultar datos ni anotar el gasto.');
}

const sb  = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const srv = SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } })
  : null;

function ponerCORS(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 15 * 1024 * 1024) { reject(new Error('body demasiado grande')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//  EL TOPE Y EL REGISTRO
//
//  Las dos funciones viven en la base (ops.ia_puede_gastar / ia_registrar_uso)
//  porque la cuenta tiene que ser una sola, la vea quien la vea.
//
//  Si no se puede consultar el tope, se DEJA PASAR: quedarse sin asistente
//  porque falló una consulta de control es peor que gastar unos centavos de
//  más. El registro, en cambio, si falla solo se avisa en el log.
// ═══════════════════════════════════════════════════════════════════════════
async function puedeGastar() {
  if (!srv) return { permitido: true, sin_control: true };
  try {
    const { data, error } = await srv.schema('ops').rpc('ia_puede_gastar');
    if (error) throw new Error(error.message);
    return data || { permitido: true, sin_control: true };
  } catch (e) {
    console.error('⚠ no se pudo consultar el tope:', e.message);
    return { permitido: true, sin_control: true };
  }
}

async function anotarUso({ modelo, respuesta, para, pregunta, herramientas, usuario, ok = true, error = null }) {
  if (!srv) return;
  const u = respuesta?.usage || {};
  try {
    await srv.schema('ops').rpc('ia_registrar_uso', {
      p_modelo: respuesta?.model || modelo || null,
      p_tokens_in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      p_tokens_out: u.output_tokens || 0,
      p_para: para || 'asistente',
      p_pregunta: String(pregunta || '').slice(0, 300),
      p_herramientas: herramientas?.length ? herramientas : null,
      p_usuario: usuario || null,
      p_ok: ok,
      p_error: error,
    });
  } catch (e) {
    console.error('⚠ no se pudo anotar el uso:', e.message);
  }
}

async function llamarAnthropic(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch (e) { json = null; }
  return { status: r.status, texto, json };
}

// ═══════════════════════════════════════════════════════════════════════════
//  LAS HERRAMIENTAS
//
//  Todas de lectura, todas acotadas: devuelven pocas filas y solo las columnas
//  que sirven para contestar. Nada de mandarle el catálogo entero, que además
//  de caro no ayuda.
//
//  Cada una explica en su descripción CUÁNDO usarla: es lo que hace que Claude
//  elija bien sin que haya que enseñarle en el prompt.
// ═══════════════════════════════════════════════════════════════════════════
const HERRAMIENTAS = [
  {
    name: 'buscar_producto',
    description: 'Busca productos por nombre o marca y devuelve precio, costo, stock por sucursal y cuánto se vendió. Usala cuando la pregunta sea sobre un producto puntual: si hay stock, a cuánto está, cuánto deja.',
    input_schema: {
      type: 'object',
      properties: { texto: { type: 'string', description: 'Parte del nombre o la marca' } },
      required: ['texto'],
    },
  },
  {
    name: 'stock_bajo',
    description: 'Los productos que están por debajo de su stock mínimo, ordenados por lo que más se vende. Usala para "qué tengo que comprar" o "qué me está faltando".',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', description: 'Cuántos traer (máximo 40)' } },
    },
  },
  {
    name: 'ventas',
    description: 'Cuánto se vendió por día y por sucursal en los últimos días, con la cantidad de tickets. Usala para preguntas de facturación, comparar sucursales o ver cómo viene el mes.',
    input_schema: {
      type: 'object',
      properties: { dias: { type: 'integer', description: 'Cuántos días hacia atrás (máximo 90)' } },
    },
  },
  {
    name: 'mas_vendidos',
    description: 'Los productos más vendidos de los últimos 90 días, en unidades. Usala para saber qué mueve el negocio o qué conviene tener siempre.',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', description: 'Cuántos traer (máximo 30)' } },
    },
  },
  {
    name: 'sin_rotacion',
    description: 'Productos con stock que hace mucho que no se venden: plata parada en el depósito. Usala para preguntas de rotación, liquidaciones u ofertas.',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', description: 'Cuántos traer (máximo 30)' } },
    },
  },
  {
    name: 'socios',
    description: 'Cómo viene el Club: cuántos socios hay de cada plan y cuántos entraron este mes. Usala para preguntas sobre el club o las membresías.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'proveedores',
    description: 'Los proveedores: qué se les debe, qué vence pronto y cuánto se les compró. Usala para "a quién le debo", "qué pago esta semana", "cuánto le compramos a X" o cuando la pregunta sea sobre compras.',
    input_schema: {
      type: 'object',
      properties: { nombre: { type: 'string', description: 'Opcional: para mirar uno solo' } },
    },
  },
  {
    name: 'que_compra_cada_proveedor',
    description: 'Qué productos trae cada proveedor, con su precio y cuánto se vende. Usala cuando pregunten a quién comprarle algo, o qué trae un proveedor.',
    input_schema: {
      type: 'object',
      properties: {
        producto: { type: 'string', description: 'Parte del nombre de un producto, para ver quién lo trae' },
        proveedor: { type: 'string', description: 'Parte del nombre de un proveedor, para ver qué trae' },
      },
    },
  },
  {
    name: 'recordar',
    description: 'Guarda una nota sobre cómo funciona este negocio, para tenerla en cuenta en todas las consultas siguientes. Usala cuando te corrijan un dato, te expliquen una palabra que se usa adentro o te digan una regla del negocio que no está en los datos. No la uses para guardar números que cambian (stock, precios, ventas): esos se consultan cada vez.',
    input_schema: {
      type: 'object',
      properties: { nota: { type: 'string', description: 'La nota, en una o dos frases, como se la contarías a alguien que entra a trabajar mañana' } },
      required: ['nota'],
    },
  },
  {
    name: 'sin_peso',
    description: 'Productos sin peso cargado: la tienda online no les puede cotizar el envío. Usala si preguntan por envíos, por la tienda online o qué falta configurar.',
    input_schema: {
      type: 'object',
      properties: { limite: { type: 'integer', description: 'Cuántos traer (máximo 30)' } },
    },
  },
];

const tope = (n, def, max) => Math.min(Math.max(parseInt(n || def, 10) || def, 1), max);

// ── LAS SUCURSALES, POR SU NOMBRE ──
//
// El asistente decía "bv1: 2, bv2: 3, bv3: 0". Nadie en el negocio habla
// así, y peor: bv3 es Chacras, que cerró. Un dato viejo dicho con seguridad
// es el peor error que puede cometer.
//
// Se leen una vez cada cinco minutos: cambian una vez por año.
let sucursalesCache = { at: 0, datos: null };

async function sucursales() {
  if (sucursalesCache.datos && Date.now() - sucursalesCache.at < 5 * 60 * 1000) {
    return sucursalesCache.datos;
  }
  try {
    const { data, error } = await srv.schema('ops').from('sucursales').select('id,nombre,activa');
    if (error) throw new Error(error.message);
    const vivas = (data || []).filter(s => s.activa !== false);
    // Una lista vacía casi seguro es un error de lectura, no un negocio sin
    // locales: no se cachea, así se reintenta en la consulta siguiente.
    if (vivas.length) sucursalesCache = { at: Date.now(), datos: vivas };
    else return [];
  } catch (e) {
    console.error('⚠ no se pudieron leer las sucursales:', e.message);
    if (!sucursalesCache.datos) sucursalesCache = { at: 0, datos: [] };
  }
  return sucursalesCache.datos;
}

// Convierte {bv1: 12, bv3: 0} en {Beltrán: 12}: nombres reales y sin las que
// ya no existen.
function conNombres(porId, lista) {
  // Sin la lista de sucursales no se puede traducir, y esconder el stock
  // sería peor que mostrarlo con su código: se devuelve tal cual.
  if (!lista?.length) return porId || {};
  const nombre = Object.fromEntries(lista.map(s => [s.id, s.nombre || s.id]));
  const salida = {};
  Object.entries(porId || {}).forEach(([id, v]) => {
    if (nombre[id]) salida[nombre[id]] = v;
  });
  return salida;
}

// Trae una tabla completa en páginas de 1000, que es el tope de PostgREST.
async function traerTodo(cliente, esquema, vista, columnas, filtro) {
  const filas = [];
  for (let vuelta = 0; vuelta < 12; vuelta++) {
    let q = cliente.schema(esquema).from(vista).select(columnas);
    if (filtro) q = filtro(q);            // los filtros, antes del rango
    const { data, error } = await q.range(vuelta * 1000, vuelta * 1000 + 999);
    if (error) throw new Error(error.message);
    filas.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  return filas;
}

async function ejecutarHerramienta(nombre, entrada) {
  if (!srv) return { error: 'El asistente no tiene acceso a los datos en este momento.' };
  const e = entrada || {};

  if (nombre === 'buscar_producto') {
    const texto = String(e.texto || '').trim().slice(0, 60);
    if (!texto) return { error: 'Falta qué buscar' };
    // ── DOS BÚSQUEDAS, NO UN `or` ──
    //
    // Con .or(...) el patrón viaja adentro de un texto que PostgREST vuelve a
    // parsear, y el % del ilike se pierde por el camino: la consulta no
    // fallaba, devolvía CERO. El asistente entonces contestaba "no tengo
    // ningún producto con ese nombre" teniendo 2.022 cargados.
    //
    // Dos consultas simples y se juntan acá. Y si el texto trae varias
    // palabras —"almendra premium"— se busca también por la primera sola,
    // porque nadie escribe el nombre tal cual está en el sistema.
    const columnas = 'id,nombre,marca,precio_venta,costo_sin_iva,stock_kg_actual,activo,se_vende';
    const patrones = [texto];
    const primera = texto.split(/\s+/)[0];
    if (primera && primera.length >= 4 && primera !== texto) patrones.push(primera);

    const encontrados = new Map();
    for (const patron of patrones) {
      const [porNombre, porMarca] = await Promise.all([
        srv.schema('ops').from('productos').select(columnas).ilike('nombre', `%${patron}%`).limit(8),
        srv.schema('ops').from('productos').select(columnas).ilike('marca', `%${patron}%`).limit(8),
      ]);
      if (porNombre.error) throw new Error(porNombre.error.message);
      for (const p of [...(porNombre.data || []), ...(porMarca.data || [])]) {
        if (!encontrados.has(p.id)) encontrados.set(p.id, p);
      }
      if (encontrados.size) break;   // si la búsqueda exacta trajo algo, alcanza
    }

    const prods = [...encontrados.values()].slice(0, 8);
    if (!prods.length) return { resultado: [], nota: 'No hay ningún producto con ese nombre' };

    const ids = prods.map(p => p.id);
    const [{ data: stock }, { data: vend }] = await Promise.all([
      srv.schema('ops').from('stock_sucursal').select('producto_id,sucursal_id,cantidad').in('producto_id', ids),
      srv.schema('club').from('ventas_resumen').select('producto_id,unidades').in('producto_id', ids),
    ]);
    const locales = await sucursales();
    const porProd = {};
    (stock || []).forEach(s => {
      porProd[s.producto_id] = porProd[s.producto_id] || {};
      porProd[s.producto_id][s.sucursal_id] = Number(s.cantidad) || 0;
    });
    const ventas = Object.fromEntries((vend || []).map(v => [v.producto_id, Number(v.unidades) || 0]));

    return {
      resultado: prods.map(p => ({
        id: p.id,
        nombre: p.nombre,
        marca: p.marca,
        precio: Number(p.precio_venta) || 0,
        costo_sin_iva: Number(p.costo_sin_iva) || 0,
        stock_por_sucursal: conNombres(porProd[p.id], locales),
        kg_a_granel: Number(p.stock_kg_actual) || 0,
        unidades_90d: ventas[p.id] || 0,
        se_vende: p.se_vende !== false && p.activo !== false,
      })),
    };
  }

  if (nombre === 'stock_bajo') {
    const limite = tope(e.limite, 15, 40);
    const [prods, stock, vend] = await Promise.all([
      traerTodo(srv, 'ops', 'productos', 'id,nombre,marca,stock_minimo_sucursal,precio_venta,activo,se_vende',
        q => q.eq('activo', true).eq('se_vende', true)),
      traerTodo(srv, 'ops', 'stock_sucursal', 'producto_id,sucursal_id,cantidad'),
      traerTodo(srv, 'club', 'ventas_resumen', 'producto_id,unidades'),
    ]);
    const total = {};
    stock.forEach(s => { total[s.producto_id] = (total[s.producto_id] || 0) + (Number(s.cantidad) || 0); });
    const ventas = Object.fromEntries(vend.map(v => [v.producto_id, Number(v.unidades) || 0]));

    const faltan = prods
      .map(p => ({
        nombre: p.nombre, marca: p.marca,
        stock: total[p.id] || 0,
        minimo: Number(p.stock_minimo_sucursal) || 0,
        unidades_90d: ventas[p.id] || 0,
        precio: Number(p.precio_venta) || 0,
      }))
      .filter(p => p.minimo > 0 && p.stock <= p.minimo)
      .sort((a, b) => b.unidades_90d - a.unidades_90d)
      .slice(0, limite);

    return { resultado: faltan, nota: `${faltan.length} productos en o por debajo del mínimo` };
  }

  if (nombre === 'ventas') {
    const dias = tope(e.dias, 14, 90);
    const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    const filas = await traerTodo(srv, 'ops', 'ventas_pos',
      'fecha,sucursal_id,monto_total,cancelada', q => q.gte('fecha', desde));
    const porDia = {};
    filas.filter(v => v.cancelada !== true).forEach(v => {
      const k = `${v.fecha}|${v.sucursal_id}`;
      porDia[k] = porDia[k] || { fecha: v.fecha, sucursal: v.sucursal_id, total: 0, tickets: 0 };
      porDia[k].total += Number(v.monto_total) || 0;
      porDia[k].tickets++;
    });
    const locales = await sucursales();
    const nombre = Object.fromEntries(locales.map(s => [s.id, s.nombre || s.id]));
    const lista = Object.values(porDia)
      .filter(d => !locales.length || nombre[d.sucursal])
      .map(d => ({ ...d, sucursal: nombre[d.sucursal] || d.sucursal }))
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
    return { resultado: lista, nota: `ventas de los últimos ${dias} días, por día y sucursal` };
  }

  if (nombre === 'mas_vendidos') {
    const limite = tope(e.limite, 15, 30);
    const { data, error } = await srv.schema('club').from('ventas_resumen')
      .select('producto_id,unidades').order('unidades', { ascending: false }).limit(limite);
    if (error) throw new Error(error.message);
    const ids = (data || []).map(v => v.producto_id);
    const { data: prods } = await srv.schema('ops').from('productos')
      .select('id,nombre,marca,precio_venta').in('id', ids.length ? ids : [0]);
    const nom = Object.fromEntries((prods || []).map(p => [p.id, p]));
    return {
      resultado: (data || []).map(v => ({
        nombre: nom[v.producto_id]?.nombre || `#${v.producto_id}`,
        marca: nom[v.producto_id]?.marca || null,
        precio: Number(nom[v.producto_id]?.precio_venta) || 0,
        unidades_90d: Number(v.unidades) || 0,
      })),
    };
  }

  if (nombre === 'sin_rotacion') {
    const limite = tope(e.limite, 15, 30);
    const { data, error } = await srv.schema('club').from('catalogo')
      .select('nombre,marca,precio,stock_total,dias_sin_vender')
      .not('dias_sin_vender', 'is', null)
      .gt('stock_total', 0)
      .order('dias_sin_vender', { ascending: false })
      .limit(limite);
    if (error) throw new Error(error.message);
    return {
      resultado: (data || []).map(p => ({
        nombre: p.nombre, marca: p.marca,
        precio: Number(p.precio) || 0,
        stock: Number(p.stock_total) || 0,
        dias_sin_vender: p.dias_sin_vender,
        plata_parada: Math.round((Number(p.precio) || 0) * (Number(p.stock_total) || 0)),
      })),
    };
  }

  if (nombre === 'socios') {
    const filas = await traerTodo(srv, 'club', 'miembros', 'tier,estado,created_at,rol');
    const vivos = filas.filter(m => !['baja', 'inactivo'].includes(m.estado || '') && m.rol !== 'dueno');
    const porPlan = {};
    vivos.forEach(m => {
      const t = m.tier || 'vecino';
      porPlan[t] = (porPlan[t] || 0) + 1;
    });
    const mes = new Date().toISOString().slice(0, 7);
    return {
      resultado: {
        por_plan: porPlan,
        total: vivos.length,
        altas_este_mes: vivos.filter(m => String(m.created_at || '').slice(0, 7) === mes).length,
      },
    };
  }

  if (nombre === 'proveedores') {
    const filtro = String(e.nombre || '').trim().toLowerCase();
    const [pagos, parciales] = await Promise.all([
      traerTodo(srv, 'ops', 'pagos_proveedores', 'id,proveedor,monto,tipo,fecha_pedido,fecha_vencimiento,pagado,iva_credito'),
      traerTodo(srv, 'ops', 'pagos_parciales', 'pago_id,monto'),
    ]);
    const yaPago = {};
    parciales.forEach(x => { yaPago[x.pago_id] = (yaPago[x.pago_id] || 0) + (Number(x.monto) || 0); });

    const hoy = new Date().toISOString().slice(0, 10);
    const porProveedor = {};
    pagos.forEach(p => {
      const quien = p.proveedor || '—';
      if (filtro && !quien.toLowerCase().includes(filtro)) return;
      const monto = Number(p.monto) || 0;
      const pagado = (p.pagado === true) ? monto : (yaPago[p.id] || 0);
      const debe = Math.max(monto - pagado, 0);
      const d = porProveedor[quien] || (porProveedor[quien] = {
        proveedor: quien, debe: 0, vencido: 0, comprado_total: 0, comprobantes: 0, proximo_vencimiento: null });
      d.comprado_total += monto;
      d.comprobantes++;
      if (debe > 0) {
        d.debe += debe;
        if (p.fecha_vencimiento && p.fecha_vencimiento < hoy) d.vencido += debe;
        if (p.fecha_vencimiento && (!d.proximo_vencimiento || p.fecha_vencimiento < d.proximo_vencimiento)) {
          d.proximo_vencimiento = p.fecha_vencimiento;
        }
      }
    });

    const lista = Object.values(porProveedor)
      .map(d => ({ ...d, debe: Math.round(d.debe), vencido: Math.round(d.vencido), comprado_total: Math.round(d.comprado_total) }))
      .sort((a, b) => b.debe - a.debe).slice(0, 25);
    return { resultado: lista, nota: 'montos en pesos; "vencido" es lo que ya pasó su fecha de pago' };
  }

  if (nombre === 'que_compra_cada_proveedor') {
    const { data: provs, error: eProv } = await srv.schema('ops').from('proveedores')
      .select('id,nombre,activo');
    if (eProv) throw new Error(eProv.message);
    const nombreProv = Object.fromEntries((provs || []).map(p => [p.id, p.nombre]));

    let q = srv.schema('ops').from('productos')
      .select('id,nombre,marca,precio_venta,costo_sin_iva,proveedor_preferido_id')
      .eq('activo', true).limit(25);
    if (e.producto) q = q.ilike('nombre', `%${String(e.producto).slice(0, 40)}%`);
    if (e.proveedor) {
      const ids = (provs || []).filter(p => String(p.nombre || '').toLowerCase()
        .includes(String(e.proveedor).toLowerCase())).map(p => p.id);
      if (!ids.length) return { resultado: [], nota: 'No hay ningún proveedor con ese nombre' };
      q = q.in('proveedor_preferido_id', ids);
    }
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const ids = (data || []).map(p => p.id);
    const { data: vend } = await srv.schema('club').from('ventas_resumen')
      .select('producto_id,unidades').in('producto_id', ids.length ? ids : [0]);
    const ventas = Object.fromEntries((vend || []).map(v => [v.producto_id, Number(v.unidades) || 0]));

    return {
      resultado: (data || []).map(p => ({
        producto: p.nombre,
        marca: p.marca,
        proveedor: nombreProv[p.proveedor_preferido_id] || 'sin proveedor asignado',
        precio: Number(p.precio_venta) || 0,
        costo_sin_iva: Number(p.costo_sin_iva) || 0,
        unidades_90d: ventas[p.id] || 0,
      })),
      nota: 'el proveedor es el preferido que tiene cargado el producto',
    };
  }

  if (nombre === 'recordar') {
    const nota = String(e.nota || '').trim().slice(0, 400);
    if (nota.length < 8) return { error: 'La nota es muy corta' };
    const { error } = await srv.schema('ops').from('ia_contexto')
      .insert({ nota, origen: 'asistente' });
    if (error) throw new Error(error.message);
    contextoCache = { at: 0, texto: null };   // que la próxima consulta ya la use
    return { ok: true, nota, donde: 'Queda anotado y se puede borrar desde Cyron' };
  }

  if (nombre === 'sin_peso') {
    const limite = tope(e.limite, 15, 30);
    const { data, error } = await srv.schema('club').from('pesos_pendientes')
      .select('nombre,marca,unidades_90d').order('unidades_90d', { ascending: false }).limit(limite);
    if (error) throw new Error(error.message);
    return { resultado: data || [], nota: 'sin peso no se les puede cotizar el envío' };
  }

  return { error: `No existe la herramienta ${nombre}` };
}

// ═══════════════════════════════════════════════════════════════════════════
//  LA CONVERSACIÓN CON HERRAMIENTAS
//
//  Claude pide una herramienta, este servidor la ejecuta y le devuelve el
//  resultado; se repite hasta que contesta o hasta MAX_VUELTAS. Cada vuelta
//  se anota con su costo.
// ═══════════════════════════════════════════════════════════════════════════
const SISTEMA = `Sos el asistente interno de una dietética en Mendoza, Argentina. Hablás en español rioplatense, claro y directo.

Tenés herramientas para consultar los datos reales del negocio. Usalas siempre que la respuesta dependa de un número: nunca inventes stock, precios ni ventas. Si una herramienta no trae datos, decilo.

Los montos son en pesos argentinos. Cuando des una recomendación, apoyala en el número que viste y decí de dónde salió. Preferí respuestas cortas: tres o cuatro frases, o una lista breve. Si algo no se puede saber con las herramientas que tenés, decilo sin rodeos en vez de estimar.`;

// ══════════════════════════════════════════════════════════════════════
//  LO QUE SABE DEL NEGOCIO
//
//  El modelo no aprende con el uso: cada consulta arranca de cero. Lo único
//  que lo hace conocer el negocio es esto, que viaja en cada pregunta: quién
//  es el negocio, qué sucursales tiene HOY y las notas que fue juntando.
//
//  Se arma una vez cada cinco minutos. Si falla, el asistente trabaja igual,
//  solo que sin esa memoria.
// ══════════════════════════════════════════════════════════════════════
let contextoCache = { at: 0, texto: null };

async function contextoDelNegocio() {
  if (contextoCache.texto && Date.now() - contextoCache.at < 5 * 60 * 1000) {
    return contextoCache.texto;
  }
  let texto = '';
  try {
    const [locales, notas, config] = await Promise.all([
      sucursales(),
      srv.schema('ops').from('ia_contexto').select('nota')
        .eq('activa', true).order('created_at', { ascending: false }).limit(40),
      srv.schema('ops').from('config').select('clave,valor')
        .in('clave', ['negocio_nombre', 'negocio_rubro', 'negocio_ciudad']),
    ]);

    const cfg = Object.fromEntries((config.data || []).map(c => [c.clave, c.valor]));
    if (cfg.negocio_nombre) {
      texto += `\n\nEl negocio es ${cfg.negocio_nombre}` +
        (cfg.negocio_rubro ? `, ${cfg.negocio_rubro}` : '') +
        (cfg.negocio_ciudad ? ` en ${cfg.negocio_ciudad}` : '') + '.';
    }
    if (locales.length) {
      texto += `\nSucursales: ${locales.map(s => `${s.nombre} (${s.id})`).join(', ')}. ` +
        `No existe ninguna otra: si aparece una que no está en esta lista, es un dato viejo.`;
    }
    if ((notas.data || []).length) {
      texto += '\n\nLo que sabés de este negocio:\n' +
        notas.data.map(n => `- ${n.nota}`).join('\n');
    }
    contextoCache = { at: Date.now(), texto };
  } catch (e) {
    console.error('⚠ no se pudo armar el contexto:', e.message);
  }
  return contextoCache.texto || '';
}

async function conversarConHerramientas({ pregunta, historial, usuario, modelo }) {
  const mensajes = [];
  (historial || []).slice(-6).forEach(m => {
    if (m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
      mensajes.push({ role: m.role, content: m.content.slice(0, 2000) });
    }
  });
  mensajes.push({ role: 'user', content: String(pregunta).slice(0, 2000) });

  const usadas = [];
  let ultima = null;

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    const permiso = await puedeGastar();
    if (permiso.permitido === false) {
      return { corte: permiso, texto: null, herramientas: usadas };
    }

    const r = await llamarAnthropic({
      model: modelo,
      max_tokens: MAX_TOKENS_TOPE,
      system: SISTEMA + (srv ? await contextoDelNegocio() : ''),
      tools: srv ? HERRAMIENTAS : undefined,
      messages: mensajes,
    });

    if (r.status !== 200 || !r.json) {
      await anotarUso({ modelo, respuesta: r.json, para: 'asistente', pregunta, herramientas: usadas,
        usuario, ok: false, error: `HTTP ${r.status}` });
      return { error: r.json?.error?.message || `Anthropic respondió ${r.status}`, herramientas: usadas };
    }

    ultima = r.json;
    await anotarUso({ modelo, respuesta: r.json, para: 'asistente', pregunta, herramientas: usadas, usuario });

    const pedidos = (r.json.content || []).filter(c => c.type === 'tool_use');
    if (r.json.stop_reason !== 'tool_use' || !pedidos.length) {
      const texto = (r.json.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
      return { texto: texto || 'Sin respuesta.', herramientas: usadas, usage: r.json.usage };
    }

    mensajes.push({ role: 'assistant', content: r.json.content });

    const resultados = [];
    for (const p of pedidos) {
      usadas.push(p.name);
      let salida;
      try {
        salida = await ejecutarHerramienta(p.name, p.input);
      } catch (err) {
        console.error('⚠ herramienta', p.name, err.message);
        salida = { error: 'No se pudo consultar: ' + err.message };
      }
      resultados.push({
        type: 'tool_result',
        tool_use_id: p.id,
        content: JSON.stringify(salida).slice(0, 20000),
      });
    }
    mensajes.push({ role: 'user', content: resultados });
  }

  // Se agotaron las vueltas: se devuelve lo último que dijo, si dijo algo.
  const texto = (ultima?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return {
    texto: texto || 'Estuve dando vueltas y no llegué a una respuesta. Probá preguntarlo más puntual.',
    herramientas: usadas,
  };
}

const server = http.createServer(async (req, res) => {
  ponerCORS(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Preflight del navegador
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    return res.end(JSON.stringify({
      servicio: 'belavita-ai-proxy', ok: true,
      herramientas: srv ? HERRAMIENTAS.length : 0,
    }));
  }

  const rutaOk = req.method === 'POST' && (req.url === '/anthropic' || req.url === '/asistente');
  if (!rutaOk) {
    res.writeHead(404); return res.end(JSON.stringify({ error: 'ruta no encontrada' }));
  }

  try {
    // ── 1) Validar que sea un usuario logueado de Belavita ──
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) { res.writeHead(401); return res.end(JSON.stringify({ error: 'falta token de sesión' })); }

    const { data: { user }, error: eUser } = await sb.auth.getUser(token);
    if (eUser || !user) { res.writeHead(401); return res.end(JSON.stringify({ error: 'sesión inválida o vencida' })); }

    // ── 2) Leer y validar el body ──
    const bodyRaw = await leerBody(req);
    let body;
    try { body = JSON.parse(bodyRaw || '{}'); }
    catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'JSON inválido' })); }

    // ── 3) ¿Queda presupuesto del día? ──
    //
    // Esto va ANTES de llamar a Anthropic, y del lado del servidor: la
    // pantalla también lo muestra, pero el que corta es este.
    const permiso = await puedeGastar();
    if (permiso.permitido === false) {
      res.writeHead(429);
      return res.end(JSON.stringify({
        error: 'tope_diario',
        mensaje: `El asistente llegó al tope de gasto de hoy (US$${permiso.tope}). Mañana vuelve solo.`,
        gasto: permiso,
      }));
    }

    // ── 4a) El asistente con herramientas ──
    if (req.url === '/asistente') {
      const modelo = MODELOS_OK.includes(body.model) ? body.model : MODELO_ASISTENTE;
      const pregunta = String(body.pregunta || '').trim();
      if (!pregunta) { res.writeHead(400); return res.end(JSON.stringify({ error: 'falta la pregunta' })); }

      const r = await conversarConHerramientas({
        pregunta, historial: body.historial, usuario: user.id, modelo,
      });

      if (r.corte) {
        res.writeHead(429);
        return res.end(JSON.stringify({
          error: 'tope_diario',
          mensaje: `El asistente llegó al tope de gasto de hoy (US$${r.corte.tope}).`,
          gasto: r.corte,
        }));
      }
      if (r.error) { res.writeHead(502); return res.end(JSON.stringify({ error: r.error })); }

      const gasto = await puedeGastar();
      return res.end(JSON.stringify({
        texto: r.texto,
        herramientas: r.herramientas,
        modelo,
        gasto,
      }));
    }

    // ── 4b) La ruta de siempre: se reenvía tal cual ──
    if (!MODELOS_OK.includes(body.model)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: `modelo no permitido: ${body.model}` }));
    }
    // Tope de seguridad a max_tokens
    if (!body.max_tokens || body.max_tokens > MAX_TOKENS_TOPE) body.max_tokens = MAX_TOKENS_TOPE;

    const r = await llamarAnthropic(body);

    // Se anota acá, no en la pantalla: la foto de un remito también cuesta.
    await anotarUso({
      modelo: body.model, respuesta: r.json,
      para: body.para || (Array.isArray(body.messages?.[0]?.content) ? 'imagen' : 'asistente'),
      pregunta: typeof body.messages?.[0]?.content === 'string' ? body.messages[0].content : null,
      usuario: user.id, ok: r.status === 200,
      error: r.status === 200 ? null : `HTTP ${r.status}`,
    });

    // Devolvemos la respuesta de Anthropic TAL CUAL (mismo shape que espera el frontend)
    res.writeHead(r.status);
    res.end(r.texto);

  } catch (err) {
    console.error('✗ Error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ══════════════════════════════════════════════════════════════════════
//  REVISIÓN AL ARRANCAR
//
//  Dos preguntas, una sola vez, apenas levanta: ¿ve los productos? ¿puede
//  consultar el tope? Las dos responden a la misma duda —si la llave que
//  está configurada es la de servicio o la anónima— y la respuesta queda en
//  el log antes de que nadie pregunte nada.
//
//  Con la llave anónima no falla ruidosamente: las consultas devuelven CERO
//  filas, sin error, porque las reglas de la base no la dejan ver nada. Eso
//  es exactamente lo que se ve desde afuera como "el asistente no encuentra
//  ningún producto".
// ══════════════════════════════════════════════════════════════════════
async function revisionDeArranque() {
  if (!srv) return;

  try {
    const { count, error } = await srv.schema('ops').from('productos')
      .select('id', { count: 'exact', head: true });
    if (error) console.error('✗ no puede leer los productos:', error.message);
    else if (!count) console.error(
      '✗ ve 0 productos. Si en Cyron hay productos cargados, la llave configurada ' +
      'no es la de servicio: revisá SUPABASE_SERVICE_KEY (service_role / secret, no la anon).');
    else console.log(`✓ ve ${count} productos`);
  } catch (e) {
    console.error('✗ no puede leer los productos:', e.message);
  }

  try {
    const { error } = await srv.schema('ops').rpc('ia_puede_gastar');
    if (error) console.error(
      '✗ no puede consultar el tope:', error.message,
      '— si dice "permission denied", la llave no es la de servicio o falta el grant a service_role.');
    else console.log('✓ puede consultar el tope y anotar el gasto');
  } catch (e) {
    console.error('✗ no puede consultar el tope:', e.message);
  }
}

server.listen(PORT, () => {
  console.log(`belavita-ai-proxy escuchando en :${PORT} · ${srv ? HERRAMIENTAS.length + ' herramientas' : 'sin herramientas (falta SUPABASE_SERVICE_KEY)'}`);
  revisionDeArranque();
});

module.exports = { server, HERRAMIENTAS, ejecutarHerramienta, conversarConHerramientas };
