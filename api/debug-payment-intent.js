// api/debug-recurring-charge.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois le sujet des prélèvements récurrents résolu.
// Tente de créer une NOUVELLE intention de paiement en présentant directement un client et
// une carte déjà connus de Stancer (obtenus lors d'un premier paiement), SANS repasser par la
// fenêtre de paiement (HPP). Objectif : voir concrètement si Stancer répond "authorized" tout
// seul (prélèvement automatique possible), ou s'il redemande une validation 3D Secure malgré
// tout (auquel cas un prélèvement 100% automatique sans la cliente ne serait pas possible).
//
// Usage : POST /api/debug-recurring-charge
// Body JSON : { "customer": "cust_xxxxx", "card": "card_xxxxx", "amount": 3499 }
// (customer/card = les identifiants trouvés via debug-payment-intent sur un paiement précédent)

const STANCER_API_BASE = 'https://api.stancer.com/v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée (POST uniquement)' });
  }

  const { customer, card, amount } = req.body || {};
  if (!customer || !card) {
    return res.status(400).json({ error: "'customer' et 'card' sont requis dans le body JSON" });
  }

  const secretKey = process.env.STANCER_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: 'Clé Stancer non configurée côté serveur' });
  }
  const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

  try {
    const intentRes = await fetch(`${STANCER_API_BASE}/payment_intents/`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: amount || 3499,
        currency: 'eur',
        customer: customer,
        card: card, // on présente directement la carte déjà connue, sans passer par le HPP
        capture: false,
        description: 'Test prélèvement récurrent (diagnostic)',
      }),
    });
    const intent = await intentRes.json();

    // On renvoie tout, tel quel : le point clé à observer est la présence ou non d'une "url"
    // (signe qu'une action de la cliente serait nécessaire) et la valeur de "status"/"threeds".
    return res.status(intentRes.status).json({
      httpStatus: intentRes.status,
      rawResponse: intent,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue', details: String(err) });
  }
}
