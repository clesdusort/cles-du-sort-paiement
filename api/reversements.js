// api/reversements.js
// Renvoie la liste brute des reversements Stancer (virements Stancer -> compte bancaire),
// utilisée par le volet "Paiement" de l'appli locale pour calculer le CA réellement encaissé
// sur une période donnée (déclaration URSSAF).
//
// ⚠️ Les noms de champs exacts de la réponse Stancer n'ont pas encore été vérifiés avec un
// vrai reversement (le compte n'en a pas encore eu au moment de l'écriture de ce fichier).
// On se base sur les libellés documentés dans l'export CSV officiel de Stancer :
//   - date_bank : date à laquelle le reversement a été réalisé
//   - status : statut du reversement
//   - amount (supposé) : montant total des paiements inclus
// À AJUSTER dès qu'un premier vrai reversement apparaît, si les noms diffèrent.
//
// Usage : GET /api/reversements

const STANCER_API_BASE = 'https://api.stancer.com/v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée (GET uniquement)' });
  }

  const secretKey = process.env.STANCER_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Clé Stancer non configurée côté serveur' });
  }
  const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

  try {
    const payoutsRes = await fetch(`${STANCER_API_BASE}/payouts/`, {
      headers: { Authorization: authHeader },
    });
    const data = await payoutsRes.json();

    if (!payoutsRes.ok) {
      return res.status(502).json({ error: 'Erreur lors de la récupération des reversements', details: data });
    }

    // On renvoie la liste brute, sans transformation — le tri par période et le calcul du
    // total se font côté appli, pour rester facilement ajustable dès qu'on connaît la vraie
    // structure des données.
    return res.status(200).json({ payouts: data.payouts || [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
