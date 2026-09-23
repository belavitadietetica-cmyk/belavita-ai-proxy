// ══════════════════════════════════════════════════════════════════════════
//  CREATIVO · LA SINCRONIZACIÓN CON META
//
//  Una vez por día trae de Meta todo lo de los anuncios y lo guarda en la
//  base (ops.mkt_*). El panel Creativo de Cyron lee de ahí.
//
//  Qué trae:
//    · cada anuncio, cada día: gasto, alcance, impresiones, frecuencia, clics,
//      visitas, carritos, pagos iniciados, compras y su valor, conversaciones
//      de WhatsApp y cuánto se miraron los videos
//    · desde dónde lo miran: edad y género, provincia, Instagram o Facebook y
//      en qué lugar (feed, historias, reels), celular o computadora
//    · cada anuncio con su imagen, su texto y su botón
//    · lo orgánico de Instagram: alcance, seguidores, visitas al perfil
//
//  Los últimos 7 días se vuelven a pedir siempre: Meta sigue sumando
//  compras a un anuncio hasta una semana después del clic.
//
//  Necesita, en las variables del servidor:
//    META_ADS_TOKEN       token de un usuario del sistema, con ads_read
//    META_AD_ACCOUNT_ID   la cuenta publicitaria (act_123... o solo el número)
//    META_IG_USER_ID      (opcional) la cuenta de Instagram, para lo orgánico
//  Sin token no hace nada: el resto del servidor sigue igual.
// ══════════════════════════════════════════════════════════════════════════

const GRAPH = 'https://graph.facebook.com/v21.0';
const DIAS_PRIMERA_VEZ = 90;
const DIAS_QUE_CAMBIAN = 7;

function config() {
  const cuenta = String(process.env.META_AD_ACCOUNT_ID || '').trim();
  return {
    token: String(process.env.META_ADS_TOKEN || '').trim(),
    cuenta: cuenta ? (cuenta.startsWith('act_') ? cuenta : 'act_' + cuenta) : '',
    ig: String(process.env.META_IG_USER_ID || '').trim(),
  };
}
const configurado = () => { const c = config(); return !!(c.token && c.cuenta); };

// ── Pedidos a Meta ───────────────────────────────────────────────────────────
async function graph(ruta, params = {}) {
  const url = ruta.startsWith('http') ? new URL(ruta) : new URL(GRAPH + ruta);
  if (!ruta.startsWith('http')) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    url.searchParams.set('access_token', config().token);
  }
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const e = j.error || {};
    throw new Error(`Meta: ${e.message || r.status}${e.code ? ' (código ' + e.code + ')' : ''}`);
  }
  return j;
}

// Meta devuelve de a páginas: se siguen hasta el final, con un tope por las
// dudas para no quedar dando vueltas.
async function todo(ruta, params, tope = 200) {
  const filas = [];
  let j = await graph(ruta, params);
  for (let n = 0; ; n++) {
    filas.push(...(j.data || []));
    if (!j.paging?.next || n >= tope) break;
    j = await graph(j.paging.next);
  }
  return filas;
}

// ── Leer las "acciones" de Meta ──────────────────────────────────────────────
//
// Meta repite la misma compra con varios nombres (purchase, omni_purchase,
// offsite_conversion.fb_pixel_purchase). Sumarlos la contaría tres veces:
// se toma el primero que aparezca, en este orden.
const ACCION = {
  clics_enlace:      ['link_click'],
  visitas_landing:   ['omni_landing_page_view', 'landing_page_view'],
  agregados_carrito: ['omni_add_to_cart', 'offsite_conversion.fb_pixel_add_to_cart', 'add_to_cart'],
  inicios_pago:      ['omni_initiated_checkout', 'offsite_conversion.fb_pixel_initiate_checkout', 'initiate_checkout'],
  compras:           ['omni_purchase', 'offsite_conversion.fb_pixel_purchase', 'purchase'],
  conversaciones:    ['onsite_conversion.messaging_conversation_started_7d'],
  video_3s:          ['video_view'],
};
function primera(lista, tipos) {
  for (const t of tipos) {
    const a = (lista || []).find(x => x.action_type === t);
    if (a) return Number(a.value) || 0;
  }
  return 0;
}
const video = x => primera(x, ['video_view']);
const num = v => Number(v) || 0;

function filaAnuncio(x) {
  return {
    plataforma: 'meta',
    fecha: x.date_start,
    anuncio_id: String(x.ad_id),
    anuncio: x.ad_name || null,
    conjunto_id: x.adset_id ? String(x.adset_id) : null,
    conjunto: x.adset_name || null,
    campana_id: x.campaign_id ? String(x.campaign_id) : null,
    campana: x.campaign_name || null,
    objetivo: x.objective || null,
    gasto: num(x.spend),
    impresiones: num(x.impressions),
    alcance: num(x.reach),
    frecuencia: x.frequency != null ? num(x.frequency) : null,
    clics: num(x.clicks),
    clics_enlace: num(x.inline_link_clicks) || primera(x.actions, ACCION.clics_enlace),
    visitas_landing: primera(x.actions, ACCION.visitas_landing),
    agregados_carrito: primera(x.actions, ACCION.agregados_carrito),
    inicios_pago: primera(x.actions, ACCION.inicios_pago),
    compras: primera(x.actions, ACCION.compras),
    valor_compras: primera(x.action_values, ACCION.compras),
    conversaciones: primera(x.actions, ACCION.conversaciones),
    video_3s: primera(x.actions, ACCION.video_3s),
    video_25: video(x.video_p25_watched_actions),
    video_50: video(x.video_p50_watched_actions),
    video_75: video(x.video_p75_watched_actions),
    video_100: video(x.video_p100_watched_actions),
    actualizado: new Date().toISOString(),
  };
}

// ── Desde dónde lo miran ─────────────────────────────────────────────────────
const GENERO = { female: 'mujer', male: 'hombre', unknown: 'sin dato' };
const DESGLOSES = [
  { dimension: 'edad_genero', breakdowns: 'age,gender',
    valor: x => `${x.age} · ${GENERO[x.gender] || x.gender}` },
  { dimension: 'region', breakdowns: 'region', valor: x => x.region || 'sin dato' },
  { dimension: 'red', breakdowns: 'publisher_platform,platform_position',
    valor: x => `${x.publisher_platform} · ${String(x.platform_position || '').replace(/_/g, ' ')}` },
  { dimension: 'dispositivo', breakdowns: 'impression_device', valor: x => x.impression_device || 'sin dato' },
];

// ── Guardar ──────────────────────────────────────────────────────────────────
async function guardar(srv, tabla, filas, conflicto) {
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await srv.schema('ops').from(tabla)
      .upsert(filas.slice(i, i + 500), { onConflict: conflicto });
    if (error) throw new Error(`guardar ${tabla}: ${error.message}`);
  }
  return filas.length;
}

const iso = d => d.toISOString().slice(0, 10);
function haceDias(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); }

// ¿Desde cuándo pedir? La primera vez, 90 días; después, la última semana.
async function ventana(srv) {
  const { count } = await srv.schema('ops').from('mkt_anuncios_dia')
    .select('anuncio_id', { count: 'exact', head: true }).eq('plataforma', 'meta');
  return { desde: haceDias(count ? DIAS_QUE_CAMBIAN : DIAS_PRIMERA_VEZ), hasta: haceDias(0) };
}

// ══════════════════════════════════════════════════════════════════════════
async function sincronizarMeta(srv, opciones = {}) {
  if (!configurado()) return { ok: false, motivo: 'Falta META_ADS_TOKEN o META_AD_ACCOUNT_ID' };
  if (!srv) return { ok: false, motivo: 'Falta la clave de servicio de Supabase' };

  const { cuenta, ig } = config();
  const { desde, hasta } = opciones.desde ? opciones : await ventana(srv);
  const rango = { since: desde, until: hasta };
  const hecho = { anuncios: 0, desglose: 0, creativos: 0, organico: 0, avisos: [] };

  try {
    // 1 · Cada anuncio, cada día
    const insights = await todo(`/${cuenta}/insights`, {
      level: 'ad', time_increment: 1, time_range: rango, limit: 500,
      use_unified_attribution_setting: true,
      fields: 'date_start,campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,objective,' +
              'spend,impressions,reach,frequency,clicks,inline_link_clicks,actions,action_values,' +
              'video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p100_watched_actions',
    });
    hecho.anuncios = await guardar(srv, 'mkt_anuncios_dia', insights.map(filaAnuncio), 'plataforma,fecha,anuncio_id');

    // 2 · Desde dónde lo miran. Si uno falla, los otros siguen.
    for (const d of DESGLOSES) {
      try {
        const filas = await todo(`/${cuenta}/insights`, {
          level: 'account', time_increment: 1, time_range: rango, limit: 500,
          breakdowns: d.breakdowns,
          fields: 'date_start,spend,impressions,reach,inline_link_clicks,actions,action_values',
        });
        // Dos filas de Meta pueden caer en el mismo valor: se suman.
        const juntas = new Map();
        for (const x of filas) {
          const k = x.date_start + '|' + d.valor(x);
          const f = juntas.get(k) || { plataforma: 'meta', fecha: x.date_start, dimension: d.dimension,
            valor: d.valor(x), gasto: 0, impresiones: 0, alcance: 0, clics_enlace: 0, compras: 0,
            valor_compras: 0, actualizado: new Date().toISOString() };
          f.gasto += num(x.spend); f.impresiones += num(x.impressions); f.alcance += num(x.reach);
          f.clics_enlace += num(x.inline_link_clicks);
          f.compras += primera(x.actions, ACCION.compras);
          f.valor_compras += primera(x.action_values, ACCION.compras);
          juntas.set(k, f);
        }
        hecho.desglose += await guardar(srv, 'mkt_desglose_dia', [...juntas.values()], 'plataforma,fecha,dimension,valor');
      } catch (e) { hecho.avisos.push(`${d.dimension}: ${e.message}`); }
    }

    // 3 · Cada anuncio con su imagen y su texto. Las etiquetas que puso el
    //     equipo no se mandan, así que no se pisan.
    try {
      const ads = await todo(`/${cuenta}/ads`, {
        limit: 200,
        fields: 'id,name,effective_status,campaign{name},' +
                'creative{thumbnail_url,image_url,video_id,body,title,call_to_action_type,object_story_spec}',
      });
      const filas = ads.map(a => {
        const c = a.creative || {};
        const hist = c.object_story_spec || {};
        const link = hist.link_data || {};
        const vid = hist.video_data || {};
        return {
          plataforma: 'meta',
          anuncio_id: String(a.id),
          nombre: a.name || null,
          estado: a.effective_status || null,
          campana: a.campaign?.name || null,
          miniatura: c.thumbnail_url || null,
          imagen: c.image_url || link.picture || vid.image_url || null,
          video_id: c.video_id || vid.video_id || null,
          es_video: !!(c.video_id || vid.video_id),
          texto: c.body || link.message || vid.message || null,
          titulo: c.title || link.name || vid.title || null,
          boton: c.call_to_action_type || link.call_to_action?.type || vid.call_to_action?.type || null,
          enlace: link.link || vid.call_to_action?.value?.link || null,
          actualizado: new Date().toISOString(),
        };
      });
      hecho.creativos = await guardar(srv, 'mkt_creativos', filas, 'plataforma,anuncio_id');
    } catch (e) { hecho.avisos.push(`creativos: ${e.message}`); }

    // 4 · Lo orgánico de Instagram. Meta cambia seguido qué métricas da:
    //     se piden de a una y la que no está, se saltea.
    if (ig) {
      const MET = { reach: 'alcance', follower_count: 'seguidores_nuevos', profile_views: 'visitas_perfil',
                    website_clicks: 'clics_web', views: 'vistas' };
      const filas = [];
      for (const [metrica, nombre] of Object.entries(MET)) {
        try {
          const j = await graph(`/${ig}/insights`, { metric: metrica, period: 'day', since: desde, until: hasta });
          for (const v of (j.data?.[0]?.values || [])) {
            filas.push({ plataforma: 'instagram', fecha: String(v.end_time).slice(0, 10), metrica: nombre,
                         valor: num(v.value), actualizado: new Date().toISOString() });
          }
        } catch (e) { /* esa métrica no está disponible para esta cuenta */ }
      }
      try {
        const cuentaIg = await graph(`/${ig}`, { fields: 'followers_count,media_count' });
        filas.push({ plataforma: 'instagram', fecha: hasta, metrica: 'seguidores', valor: num(cuentaIg.followers_count),
                     actualizado: new Date().toISOString() });
      } catch (e) { hecho.avisos.push(`instagram: ${e.message}`); }
      if (filas.length) hecho.organico = await guardar(srv, 'mkt_organico_dia', filas, 'plataforma,fecha,metrica');
    }

    await srv.schema('ops').from('mkt_sync').insert({
      plataforma: 'meta', desde, hasta, ok: true,
      filas: hecho.anuncios + hecho.desglose + hecho.creativos + hecho.organico,
      detalle: hecho.avisos.length ? hecho.avisos.join(' | ').slice(0, 1000) : null,
    });
    return { ok: true, desde, hasta, ...hecho };
  } catch (e) {
    await srv.schema('ops').from('mkt_sync')
      .insert({ plataforma: 'meta', desde, hasta, ok: false, detalle: String(e.message).slice(0, 1000) });
    return { ok: false, desde, hasta, motivo: e.message };
  }
}

// ── Una vez por día, a las 6:10 de Argentina ─────────────────────────────────
let TIMER = null;
function msHastaLas610() {
  const ahora = new Date();
  const obj = new Date(ahora);
  obj.setUTCHours(9, 10, 0, 0);                 // 6:10 en Argentina (UTC−3)
  if (obj <= ahora) obj.setUTCDate(obj.getUTCDate() + 1);
  return obj - ahora;
}
function programar(srv, log = console) {
  if (!configurado() || !srv) { log.log('creativo: sin token de Meta, no se programa la sincronización'); return; }
  const correr = async () => {
    const r = await sincronizarMeta(srv).catch(e => ({ ok: false, motivo: e.message }));
    log.log('creativo: sincronización', JSON.stringify(r).slice(0, 300));
  };
  // Al arrancar, si la última buena tiene más de 20 horas.
  srv.schema('ops').from('mkt_sync').select('fecha').eq('plataforma', 'meta').eq('ok', true)
    .order('fecha', { ascending: false }).limit(1)
    .then(({ data }) => {
      const ultima = data?.[0]?.fecha ? new Date(data[0].fecha) : null;
      if (!ultima || Date.now() - ultima > 20 * 3600 * 1000) correr();
    }, () => correr());
  const siguiente = () => { TIMER = setTimeout(async () => { await correr(); siguiente(); }, msHastaLas610()); };
  siguiente();
}

module.exports = { sincronizarMeta, programar, configurado, filaAnuncio, primera, ACCION, msHastaLas610 };
