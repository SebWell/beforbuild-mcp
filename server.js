import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

// --- Config ---
const API_BASE = process.env.BEFORBUILD_API_URL || 'https://api.beforbuild.com'
const API_TOKEN = process.env.BEFORBUILD_API_TOKEN || ''

// --- API helper ---
async function apiCall(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function query(operation, params = {}) {
  if (!API_TOKEN) {
    return { error: 'No API token configured. Set BEFORBUILD_API_TOKEN env var or use the auth_login tool first.' }
  }
  return apiCall('/v1/data', { operation, params, jwt: API_TOKEN })
}

// --- Modules & tables reference ---
const MODULES = {
  public: {
    label: 'General',
    tables: ['projets', 'profiles', 'organisations', 'intervenants', 'notifications'],
  },
  foncier: {
    label: 'Foncier',
    tables: ['terrains', 'parcelles_groupees', 'lettres_intention', 'compromis', 'conditions_suspensives', 'actes_authentiques', 'documents_terrain'],
  },
  bilan: {
    label: 'Bilan',
    tables: ['lots', 'bilans', 'budget_travaux', 'budget_marketing', 'alertes', 'approbations', 'garanties_bancaires', 'appels_fonds', 'tresorerie_lignes'],
  },
  contrats: {
    label: 'Contrats',
    tables: ['contrats', 'phases', 'ordres_service', 'ordres_fin', 'rendus', 'signataires', 'templates', 'clauses'],
  },
  planning: {
    label: 'Planning',
    tables: ['planning_projets', 'phases', 'jalons', 'missions', 'dependances', 'baselines', 'alertes'],
  },
  commercial: {
    label: 'Commercial',
    tables: ['contacts', 'reservations_suivi', 'commercialisateurs', 'mandats_lots', 'actions_commerciales', 'plans_vente'],
  },
  documents: {
    label: 'Documents',
    tables: ['documents', 'document_folders', 'document_types', 'conversations'],
  },
}

// --- MCP Server ---
const server = new McpServer({
  name: 'BeForBuild',
  version: '1.0.0',
  description: 'Accedez aux donnees de vos projets immobiliers BeForBuild : projets, foncier, bilan, contrats, planning, commercial et documents.',
})

// --- Tool: auth_login ---
server.tool(
  'auth_login',
  'Authentification — obtenir un token d\'acces avec email et mot de passe.',
  {
    email: z.string().describe('Adresse email du compte BeForBuild'),
    password: z.string().describe('Mot de passe'),
  },
  async ({ email, password }) => {
    const result = await apiCall('/auth/token', { email, password })
    if (result.error) {
      return { content: [{ type: 'text', text: `Echec d'authentification : ${result.error}` }] }
    }
    return {
      content: [{ type: 'text', text: `Authentification reussie.\n\nToken : ${result.access_token}\nExpire dans : ${result.expires_in}s\nUtilisateur : ${result.user?.full_name || result.user?.email}` }],
    }
  }
)

// --- Tool: list_records ---
server.tool(
  'list_records',
  'Lister les enregistrements d\'une table avec filtres, tri et pagination. Modules disponibles : public (projets, profiles, organisations), foncier (terrains, parcelles, compromis), bilan (lots, budget, alertes), contrats (contrats, phases, ordres_service), planning (phases, jalons, missions), commercial (contacts, reservations), documents (documents, dossiers).',
  {
    module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
    table: z.string().describe('Nom de la table (ex: projets, terrains, lots, contrats, contacts...)'),
    projet_id: z.string().optional().describe('Filtrer par projet (UUID)'),
    filters: z.record(z.string()).optional().describe('Filtres : { colonne: "valeur" } ou { colonne: "gte.100" }. Operateurs : eq, neq, gt, gte, lt, lte, like, ilike, in, is'),
    select: z.string().optional().describe('Colonnes a retourner, separees par des virgules (defaut: toutes)'),
    order: z.string().optional().describe('Tri : colonne.asc ou colonne.desc (defaut: created_at.desc)'),
    limit: z.number().optional().describe('Nombre max de resultats (defaut: 20)'),
    offset: z.number().optional().describe('Offset pour pagination'),
  },
  async ({ module, table, projet_id, filters, select, order, limit, offset }) => {
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

// --- Tool: get_record ---
server.tool(
  'get_record',
  'Recuperer un enregistrement par son ID.',
  {
    module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
    table: z.string().describe('Nom de la table'),
    id: z.string().describe('UUID de l\'enregistrement'),
    select: z.string().optional().describe('Colonnes a retourner'),
  },
  async ({ module, table, id, select }) => {
    const params = { id }
    if (select) params.select = select
    const result = await query(`${module}.${table}.get`, params)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Tool: create_record ---
server.tool(
  'create_record',
  'Creer un nouvel enregistrement dans une table.',
  {
    module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
    table: z.string().describe('Nom de la table'),
    data: z.record(z.any()).describe('Donnees a inserer : { colonne: valeur, ... }'),
  },
  async ({ module, table, data }) => {
    const result = await query(`${module}.${table}.create`, { data })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Tool: update_record ---
server.tool(
  'update_record',
  'Modifier un enregistrement existant.',
  {
    module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
    table: z.string().describe('Nom de la table'),
    id: z.string().describe('UUID de l\'enregistrement a modifier'),
    data: z.record(z.any()).describe('Champs a modifier : { colonne: nouvelle_valeur, ... }'),
  },
  async ({ module, table, id, data }) => {
    const result = await query(`${module}.${table}.update`, { id, data })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Tool: delete_record ---
server.tool(
  'delete_record',
  'Supprimer un enregistrement.',
  {
    module: z.string().describe('Module : public, foncier, bilan, contrats, planning, commercial, documents'),
    table: z.string().describe('Nom de la table'),
    id: z.string().describe('UUID de l\'enregistrement a supprimer'),
  },
  async ({ module, table, id }) => {
    const result = await query(`${module}.${table}.delete`, { id })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Tool: call_function ---
server.tool(
  'call_function',
  'Appeler une fonction serveur (procedure stockee).',
  {
    function_name: z.string().describe('Nom de la fonction'),
    args: z.record(z.any()).optional().describe('Arguments de la fonction'),
  },
  async ({ function_name, args }) => {
    const result = await query(`public.${function_name}.rpc`, { function_name, args: args || {} })
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
)

// --- Tool: list_modules ---
server.tool(
  'list_modules',
  'Lister tous les modules et tables disponibles dans l\'API BeForBuild.',
  {},
  async () => {
    const lines = []
    for (const [name, mod] of Object.entries(MODULES)) {
      lines.push(`\n${mod.label} (${name}):`)
      for (const t of mod.tables) {
        lines.push(`  - ${name}.${t}`)
      }
    }
    return { content: [{ type: 'text', text: `Modules et tables disponibles :\n${lines.join('\n')}` }] }
  }
)

// --- Start ---
const transport = new StdioServerTransport()
await server.connect(transport)
