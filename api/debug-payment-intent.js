// api/debug-payment-intent.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois le sujet des prélèvements récurrents résolu.
// Ne fait qu'une chose : renvoyer la réponse BRUTE de Stancer pour une intention de paiement
// déjà passée, afin qu'on voie noir sur blanc comment apparaît un jeton de carte réutilisable
// (nom exact du champ, structure), plutôt que de deviner depuis la documentation.
//
// Usage : GET /api/debug-payment-intent?id=pi_xxxxxxxxxxxx
// (id = un identifiant d'intention de paiement déjà utilisé, visible dans ton dashboard Stancer
// ou dans les logs Vercel de create-payment / capture-payment)

const STANCER_API_BASE = 'https://api.stancer.com/v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée (GET uniquement)' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: "Paramètre 'id' manquant, ex. ?id=pi_xxxxx" });
  }

  const secretKey = process.env.STANCER_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Clé Stancer non configurée côté serveur' });
  }
  const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

  try {
    const intentRes = await fetch(`${STANCER_API_BASE}/payment_intents/${id}`, {
      headers: { 'Authorization': authHeader },
    });
    const intent = await intentRes.json();

    // On renvoie tout, tel quel — c'est justement le but : voir la vraie structure complète.
    return res.status(intentRes.status).json({
      httpStatus: intentRes.status,
      rawResponse: intent,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue', details: String(err) });
  }
}
