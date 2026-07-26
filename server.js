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
// usuario logueado de Belavita, te rechaza (401). Además solo permite el modelo
// esperado y le pone tope a max_tokens, para que un token robado no pueda
// disparar trabajos gigantes.
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const PORT              = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;   // la key NUEVA (no la filtrada)
const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;   // anon key (sirve para validar tokens)
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || '*';
const MODELOS_OK        = (process.env.MODELOS_OK || 'claude-sonnet-4-6').split(',').map(s => s.trim());
const MAX_TOKENS_TOPE   = parseInt(process.env.MAX_TOKENS_TOPE || '2000', 10);

if (!ANTHROPIC_API_KEY) { console.error('✗ Falta ANTHROPIC_API_KEY. Cortando.'); process.exit(1); }
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) { console.error('✗ Falta SUPABASE_URL o SUPABASE_ANON_KEY. Cortando.'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

const server = http.createServer(async (req, res) => {
  ponerCORS(res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  // Preflight del navegador
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Health check
  if (req.method === 'GET' && req.url === '/') {
    return res.end(JSON.stringify({ servicio: 'belavita-ai-proxy', ok: true }));
  }

  if (req.method !== 'POST' || req.url !== '/anthropic') {
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

    if (!MODELOS_OK.includes(body.model)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: `modelo no permitido: ${body.model}` }));
    }
    // Tope de seguridad a max_tokens
    if (!body.max_tokens || body.max_tokens > MAX_TOKENS_TOPE) body.max_tokens = MAX_TOKENS_TOPE;

    // ── 3) Reenviar a Anthropic con la key del lado servidor ──
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });

    // Devolvemos la respuesta de Anthropic TAL CUAL (mismo shape que espera el frontend)
    const texto = await r.text();
    res.writeHead(r.status);
    res.end(texto);

  } catch (err) {
    console.error('✗ Error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log(`belavita-ai-proxy escuchando en :${PORT}`));
