// api/capture-payment.js
// Fonction serverless (Vercel) : confirme et capture un paiement Stancer
// une fois que le Payeur a terminé la partie carte + 3D Secure dans l'iframe.
//
// Flux documenté par Stancer (https://docs.stancer.com/fr/API.html) :
//   1. GET  /v2/payment_intent/<pi_id>          → vérifie que le statut est "authorized"
//   2. POST /v2/payment_intent/<pi_id>/capture  → déclenche la capture réelle des fonds
//
// ⚠️ Sans cet appel, l'argent reste juste "autorisé" (bloqué chez le Payeur)
// mais jamais réellement débité — Carole ne serait jamais payée.

const STANCER_API_BASE = 'https://api.stancer.com/v2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://clesdusort.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { paymentIntentId } = req.body;
    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId manquant' });
    }

    const secretKey = process.env.STANCER_SECRET_KEY;
    if (!secretKey) {
      return res.status(500).json({ error: 'Clé Stancer non configurée côté serveur' });
    }
    const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

    // 1. Vérifier le statut réel de l'intention de paiement
    const statusRes = await fetch(`${STANCER_API_BASE}/payment_intent/${paymentIntentId}`, {
      headers: { 'Authorization': authHeader },
    });
    const intent = await statusRes.json();
    if (!statusRes.ok) {
      return res.status(502).json({ error: 'Impossible de vérifier le paiement', details: intent });
    }

    if (intent.status !== 'authorized') {
      // Le paiement n'est pas (ou plus) au bon statut : ne pas capturer, informer le front
      return res.status(409).json({
        error: `Le paiement n'est pas prêt à être capturé (statut actuel : ${intent.status}).`,
        status: intent.status,
      });
    }

    // 2. Capturer réellement les fonds
    const captureRes = await fetch(`${STANCER_API_BASE}/payment_intent/${paymentIntentId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': authHeader },
    });
    const captureResult = await captureRes.json();
    if (!captureRes.ok) {
      return res.status(502).json({ error: 'Erreur lors de la capture', details: captureResult });
    }

    return res.status(200).json({ success: true, status: captureResult.status || 'to_capture' });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
