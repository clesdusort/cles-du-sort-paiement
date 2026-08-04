// api/capture-payment.js
// Fonction serverless (Vercel) : confirme et capture un paiement Stancer
// une fois que le Payeur a terminé la partie carte + 3D Secure dans l'iframe.
//
// Flux Stancer :
//   1. GET  /v2/payment_intents/<pi_id>          → vérifie que le statut est "authorized"
//   2. POST /v2/payment_intents/<pi_id>/capture  → déclenche la capture réelle des fonds
//
// ⚠️ CORRECTIF : endpoint aligné au PLURIEL (/payment_intents/) pour être cohérent avec
// create-payment.js, qui crée l'intention sur /payment_intent/ (pluriel) et fonctionne
// correctement (confirmé par un test réel : statut 200, module de paiement Stancer affiché
// avec le bon montant). L'ancienne version de ce fichier utilisait /payment_intent/ (singulier)
// pour relire le statut, ce qui ne correspondait pas à la ressource créée et provoquait une
// erreur 502 ("Impossible de vérifier le paiement") à chaque tentative de capture.
//
// ⚠️ Sans l'appel de capture, l'argent reste juste "autorisé" (bloqué chez le Payeur)
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
    const statusRes = await fetch(`${STANCER_API_BASE}/payment_intents/${paymentIntentId}`, {
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
    const captureRes = await fetch(`${STANCER_API_BASE}/payment_intents/${paymentIntentId}/capture`, {
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
