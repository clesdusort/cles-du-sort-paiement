// api/marquer-resiliation.js
// Marque une abonnée comme "en cours de résiliation" côté serveur — le prélèvement
// automatique du 5 du mois continue de se faire une dernière fois (mois déjà dû, CGV
// Article 7), puis s'arrête tout seul juste après, sans intervention supplémentaire.
// ⚠️ À utiliser EN PLUS de la mise à jour du statut dans l'appli locale (les deux systèmes
// sont séparés, l'un ne met pas l'autre à jour automatiquement).
//
// Usage : POST /api/marquer-resiliation
// Body JSON : { "email": "cliente@exemple.com" }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'Upstash non configuré' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email manquant' });

  try {
    const membersRes = await fetch(`${kvUrl}/smembers/abonnements_actifs`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const membersData = await membersRes.json();
    const keys = membersData.result || [];

    for (const key of keys) {
      const getRes = await fetch(`${kvUrl}/get/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const getData = await getRes.json();
      if (!getData.result) continue;
      const abo = JSON.parse(getData.result);
      if (abo.email === email) {
        abo.statut = 'resiliation_demandee';
        await fetch(`${kvUrl}/set/${key}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(abo),
        });
        return res.status(200).json({ success: true, message: `${email} marquée en résiliation — prélevée une dernière fois puis arrêtée automatiquement.` });
      }
    }
    return res.status(404).json({ error: `Aucune abonnée active trouvée avec l'email ${email}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
