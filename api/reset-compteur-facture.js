// api/reset-compteur-facture.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois le reset effectué.
// Remet à zéro le compteur de numérotation des factures pour une année donnée : la
// PROCHAINE facture générée après ce reset portera le numéro {annee}-001.
//
// Usage : POST /api/reset-compteur-facture
// Body JSON : { "annee": 2026 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée (POST uniquement)' });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return res.status(500).json({ error: 'Upstash non configuré côté serveur' });
  }

  const { annee } = req.body || {};
  if (!annee) {
    return res.status(400).json({ error: 'annee manquante, ex. { "annee": 2026 }' });
  }

  try {
    const key = `facture_counter_${annee}`;
    const delRes = await fetch(`${url}/del/${key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const delData = await delRes.json();

    return res.status(200).json({
      success: true,
      message: `Compteur ${annee} remis à zéro. La prochaine facture sera ${annee}-001.`,
      details: delData,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
