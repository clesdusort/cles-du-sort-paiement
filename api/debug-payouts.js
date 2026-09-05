// api/debug-payouts.js
// ⚠️ OUTIL TEMPORAIRE — à supprimer une fois le sujet des reversements/URSSAF résolu.
// Teste l'accès à l'API des reversements Stancer, sans rien construire dessus encore —
// on veut juste voir si l'appel fonctionne, et à quoi ressemble une vraie réponse.
//
// Usage : GET /api/debug-payouts

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

    return res.status(payoutsRes.status).json({
      httpStatus: payoutsRes.status,
      rawResponse: data,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue', details: String(err) });
  }
}
