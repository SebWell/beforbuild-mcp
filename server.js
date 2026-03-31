import { createServer } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

// --- Config ---
const PORT = parseInt(process.env.PORT || '3000', 10)
const API_BASE = process.env.BEFORBUILD_API_URL || 'https://api.beforbuild.com'
const SESSION_TTL_MS = 5 * 60 * 1000 // 5 minutes

// --- Auth session store (sessionToken → { jwt, createdAt }) ---
const authSessions = new Map()

// Cleanup expired sessions every minute
setInterval(() => {
  const now = Date.now()
  for (const [token, session] of authSessions) {
    if (now - session.createdAt > SESSION_TTL_MS) {
      authSessions.delete(token)
    }
  }
}, 60_000)

// --- API helper ---
async function apiCall(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function queryWithToken(jwt) {
  return async (operation, params = {}) => {
    if (!jwt) {
      return { error: 'Non authentifie. Creez une session via POST /auth/session ou utilisez auth_login.' }
    }
    return apiCall('/v1/data', { operation, params, jwt })
  }
}

// --- Modules reference ---
const MODULES = {
  public: { label: 'General', tables: ['projets', 'profiles', 'organisations', 'intervenants', 'notifications'] },
  foncier: { label: 'Foncier', tables: ['terrains', 'parcelles_groupees', 'lettres_intention', 'compromis', 'conditions_suspensives', 'actes_authentiques', 'documents_terrain'] },
  bilan: { label: 'Bilan', tables: ['lots', 'bilans', 'budget_travaux', 'budget_marketing', 'alertes', 'approbations', 'garanties_bancaires', 'appels_fonds', 'tresorerie_lignes'] },
  contrats: { label: 'Contrats', tables: ['contrats', 'phases', 'ordres_service', 'ordres_fin', 'rendus', 'signataires', 'templates', 'clauses'] },
  planning: { label: 'Planning', tables: ['planning_projets', 'phases', 'jalons', 'missions', 'dependances', 'baselines', 'alertes'] },
  commercial: { label: 'Commercial', tables: ['contacts', 'reservations_suivi', 'commercialisateurs', 'mandats_lots', 'actions_commerciales', 'plans_vente'] },
  documents: { label: 'Documents', tables: ['documents', 'document_folders', 'document_types', 'conversations'] },
}

// --- Build MCP server with session JWT injected via closure ---
function createMcpServer(sessionJwt) {
  // Mutable ref — can be set later via auth_login
  let jwt = sessionJwt || null

  function getJwt(toolJwt) {
    return toolJwt || jwt
  }

  const server = new McpServer({
    name: 'BeForBuild',
    version: '1.2.0',
    description: 'Accedez aux donnees de vos projets immobiliers BeForBuild : projets, foncier, bilan, contrats, planning, commercial et documents.',
  })

  // auth_login — fallback for clients without session pre-auth
  server.tool(
    'auth_login',
    'Authentification — obtenir un token d\'acces avec email et mot de passe. Inutile si la session est deja authentifiee.',
    { email: z.string().describe('Adresse email du compte BeForBuild'), password: z.string().describe('Mot de passe') },
    async ({ email, password }) => {
      const result = await apiCall('/auth/token', { email, password })
      if (result.error) {
        return { content: [{ type: 'text', text: `Echec : ${result.error}` }] }
      }
      if (result.access_token) {
        jwt = result.access_token
      }
      return { content: [{ type: 'text', text: `Authentification reussie. Utilisateur : ${result.user?.full_name || result.user?.email}` }] }
    }
  )

  // list_records
  server.tool(
    'list_records',
    'Lister les enregistrements d\'une table avec filtres, tri et pagination. Modules : public, foncier, bilan, contrats, planning, commercial, documents.',
    {
      module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
      table: z.string().describe('Nom de la table (ex: projets, terrains, lots, contrats, contacts...)'),
      projet_id: z.string().optional().describe('Filtrer par projet (UUID)'),
      filters: z.record(z.string()).optional().describe('Filtres : { colonne: "valeur" }. Operateurs : eq, neq, gt, gte, lt, lte, like, ilike, in, is'),
      select: z.string().optional().describe('Colonnes a retourner, separees par des virgules'),
      order: z.string().optional().describe('Tri : colonne.asc ou colonne.desc'),
      limit: z.number().optional().describe('Nombre max de resultats (defaut: 20)'),
      offset: z.number().optional().describe('Offset pour pagination'),
    },
    async ({ module, table, projet_id, filters, select, order, limit, offset }) => {
      const query = queryWithToken(getJwt())
      const params = {}
      if (projet_id) params.projet_id = projet_id
      if (filters) params.filters = filters
      if (select) params.select = select
      if (order) params.order = order
      if (limit) params.limit = limit
      if (offset) params.offset = offset
      const result = await query(`${module}.${table}.list`, params)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // get_record
  server.tool(
    'get_record',
    'Recuperer un enregistrement par son ID.',
    {
      module: z.string().describe('Module'),
      table: z.string().describe('Nom de la table'),
      id: z.string().describe('UUID de l\'enregistrement'),
      select: z.string().optional().describe('Colonnes a retourner'),
    },
    async ({ module, table, id, select }) => {
      const query = queryWithToken(getJwt())
      const params = { id }
      if (select) params.select = select
      const result = await query(`${module}.${table}.get`, params)
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // create_record
  server.tool(
    'create_record',
    'Creer un nouvel enregistrement dans une table.',
    {
      module: z.string().describe('Module'),
      table: z.string().describe('Nom de la table'),
      data: z.record(z.any()).describe('Donnees a inserer : { colonne: valeur, ... }'),
    },
    async ({ module, table, data }) => {
      const query = queryWithToken(getJwt())
      const result = await query(`${module}.${table}.create`, { data })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // update_record
  server.tool(
    'update_record',
    'Modifier un enregistrement existant.',
    {
      module: z.string().describe('Module'),
      table: z.string().describe('Nom de la table'),
      id: z.string().describe('UUID de l\'enregistrement a modifier'),
      data: z.record(z.any()).describe('Champs a modifier : { colonne: nouvelle_valeur, ... }'),
    },
    async ({ module, table, id, data }) => {
      const query = queryWithToken(getJwt())
      const result = await query(`${module}.${table}.update`, { id, data })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // delete_record
  server.tool(
    'delete_record',
    'Supprimer un enregistrement.',
    {
      module: z.string().describe('Module'),
      table: z.string().describe('Nom de la table'),
      id: z.string().describe('UUID de l\'enregistrement a supprimer'),
    },
    async ({ module, table, id }) => {
      const query = queryWithToken(getJwt())
      const result = await query(`${module}.${table}.delete`, { id })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // call_function
  server.tool(
    'call_function',
    'Appeler une fonction serveur (procedure stockee).',
    {
      function_name: z.string().describe('Nom de la fonction'),
      args: z.record(z.any()).optional().describe('Arguments de la fonction'),
    },
    async ({ function_name, args }) => {
      const query = queryWithToken(getJwt())
      const result = await query(`public.${function_name}.rpc`, { function_name, args: args || {} })
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    }
  )

  // list_modules
  server.tool(
    'list_modules',
    'Lister tous les modules et tables disponibles.',
    {},
    async () => {
      const lines = []
      for (const [name, mod] of Object.entries(MODULES)) {
        lines.push(`\n${mod.label} (${name}):`)
        for (const t of mod.tables) lines.push(`  - ${name}.${t}`)
      }
      return { content: [{ type: 'text', text: `Modules et tables disponibles :\n${lines.join('\n')}` }] }
    }
  )

  return server
}

// --- HTTP Server ---
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
  'Access-Control-Allow-Headers': 'Content-Type, mcp-session-id, Authorization',
  'Access-Control-Expose-Headers': 'mcp-session-id',
}

// Store MCP transports by session ID
const sessions = new Map()

// Read request body as JSON
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()))
      } catch {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req, res) => {
  // CORS
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  // ---- Health check ----
  if (url.pathname === '/health' || (url.pathname === '/' && req.method === 'GET')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      name: 'BeForBuild MCP Server',
      version: '1.2.0',
      status: 'ok',
      transport: 'streamable-http',
      endpoint: '/mcp',
      auth: 'POST /auth/session with { jwt } in body → returns { session_token }. Then /mcp?session=<token>.',
    }))
  }

  // ---- POST /auth/session — exchange JWT for opaque session token ----
  if (url.pathname === '/auth/session' && req.method === 'POST') {
    const body = await readJsonBody(req)
    const jwt = body?.jwt

    if (!jwt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: 'Missing jwt in request body' }))
    }

    // Generate opaque session token (not the JWT itself)
    const sessionToken = crypto.randomUUID()
    authSessions.set(sessionToken, { jwt, createdAt: Date.now() })

    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      session_token: sessionToken,
      expires_in: SESSION_TTL_MS / 1000,
    }))
  }

  // ---- POST /v1/data — REST proxy with session_token (for CF Worker ai-orchestrator) ----
  if (url.pathname === '/v1/data' && req.method === 'POST') {
    const body = await readJsonBody(req)
    if (!body?.operation) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: "Missing 'operation'" }))
    }

    // Resolve JWT from session_token
    let jwt = body.jwt || null
    if (!jwt && body.session_token) {
      const session = authSessions.get(body.session_token)
      if (session && (Date.now() - session.createdAt < SESSION_TTL_MS)) {
        jwt = session.jwt
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'Invalid or expired session_token' }))
      }
    }
    if (!jwt) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ error: "Missing 'jwt' or 'session_token'" }))
    }

    // Forward to api-proxy with resolved JWT
    const result = await apiCall('/v1/data', { operation: body.operation, params: body.params || {}, jwt })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(result))
  }

  // ---- MCP endpoint ----
  if (url.pathname === '/mcp') {
    const mcpSessionId = req.headers['mcp-session-id']

    if (req.method === 'POST') {
      let transport = sessions.get(mcpSessionId)

      if (!transport) {
        // Resolve JWT from session token (secure) or Authorization header (fallback)
        let resolvedJwt = null

        // 1. Session token via query param (opaque, non-sensitive)
        const sessionToken = url.searchParams.get('session')
        if (sessionToken) {
          const session = authSessions.get(sessionToken)
          if (session && (Date.now() - session.createdAt < SESSION_TTL_MS)) {
            resolvedJwt = session.jwt
          }
        }

        // 2. Fallback: Authorization header (for direct API clients)
        if (!resolvedJwt) {
          const authHeader = req.headers['authorization']
          if (authHeader?.startsWith('Bearer ')) {
            resolvedJwt = authHeader.slice(7)
          }
        }

        // Create transport
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport)
          },
        })

        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId)
        }

        // Create MCP server with JWT injected via closure — JWT never leaves the server
        const mcpServer = createMcpServer(resolvedJwt)
        await mcpServer.connect(transport)
      }

      await transport.handleRequest(req, res)
      return
    }

    if (req.method === 'GET') {
      const transport = sessions.get(mcpSessionId)
      if (!transport) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'No session. Send a POST to /mcp first.' }))
      }
      await transport.handleRequest(req, res)
      return
    }

    if (req.method === 'DELETE') {
      const transport = sessions.get(mcpSessionId)
      if (transport) {
        await transport.close()
        sessions.delete(mcpSessionId)
      }
      res.writeHead(204)
      return res.end()
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: `Unknown: ${req.method} ${url.pathname}` }))
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`BeForBuild MCP Server v1.2.0 running on port ${PORT}`)
  console.log(`  Health:  http://localhost:${PORT}/health`)
  console.log(`  Auth:    POST http://localhost:${PORT}/auth/session { jwt }`)
  console.log(`  MCP:     http://localhost:${PORT}/mcp?session=<token>`)
})
