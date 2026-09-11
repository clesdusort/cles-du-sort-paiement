// api/debug-remove-abonnement.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer juste après usage.
// Retire complètement un abonnement de test d'Upstash (contrairement à une résiliation,
// qui prélève une dernière fois avant de s'arrêter, ici on supprime tout de suite, sans
// aucun prélèvement).
//
// Usage : POST /api/debug-remove-abonnement
// Body JSON : { "customer": "cust_..." }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Upstash non configuré' });

  const { customer } = req.body || {};
  if (!customer) return res.status(400).json({ error: 'customer manquant' });

  const key = `abonnement_${customer}`;
  await fetch(`${kvUrl}/del/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
  await fetch(`${kvUrl}/srem/abonnements_actifs/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });

  return res.status(200).json({ success: true, message: `${key} supprimé.` });
}
