// api/debug-recurring-charge-v2.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois ce test terminé.
// Reprend exactement le même principe que le test précédent (présenter directement un
// customer + card déjà connus, sans repasser par le HPP), MAIS avec "capture": true au lieu
// de "capture": false — suite à la question de Mathieu (support Stancer) suggérant que le
// statut "require_authentication" pourrait être spécifique au mode "autoriser puis capturer
// séparément", pas à un paiement direct en une seule étape.
//
// Usage : POST /api/debug-recurring-charge-v2
// Body JSON : { "customer": "cust_xxxxx", "card": "card_xxxxx", "amount": 3499 }

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
        card: card,
        capture: true, // ⚠️ différence clé avec le test précédent (qui utilisait false)
        description: 'Test capture:true (diagnostic)',
      }),
    });
    const intent = await intentRes.json();

    return res.status(intentRes.status).json({
      httpStatus: intentRes.status,
      rawResponse: intent,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue', details: String(err) });
  }
}
