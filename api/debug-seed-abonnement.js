// api/debug-seed-abonnement.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois le test du moteur terminé.
// Insère directement une fausse abonnée dans Upstash, avec une échéance "ce mois-ci" —
// pour tester le prélèvement automatique sans attendre le vrai 5 du mois prochain.
//
// Usage : POST /api/debug-seed-abonnement
// Body JSON : { "customer": "cust_...", "card": "card_...", "email": "...", "prenom": "...", "nom": "..." }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Upstash non configuré' });

  const { customer, card, email, prenom, nom } = req.body || {};
  if (!customer || !card || !email) {
    return res.status(400).json({ error: 'customer, card et email sont requis' });
  }

  const now = new Date();
  const record = {
    customer, card, email,
    prenom: prenom || 'Test',
    nom: nom || 'Moteur',
    adresse: '11 rue Lacroix Robert',
    codePostal: '78800',
    ville: 'Houilles',
    pays: 'France',
    prochainMois: now.getMonth(),    // échéance CE mois-ci, pour un test immédiat
    prochainAnnee: now.getFullYear(),
    statut: 'actif',
    echecsConsecutifs: 0,
    dateInscription: now.toISOString(),
  };

  const key = `abonnement_${customer}`;
  await fetch(`${kvUrl}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(record),
  });
  await fetch(`${kvUrl}/sadd/abonnements_actifs/${key}`, {
    headers: { Authorization: `Bearer ${kvToken}` },
  });

  return res.status(200).json({ success: true, key, record });
}
