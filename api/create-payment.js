// api/create-payment.js
// Fonction serverless (Vercel) : crée un client + une intention de paiement Stancer,
// et renvoie l'URL de la page de paiement hébergée (HPP) à afficher en iframe.
//
// ⚠️ À DÉPLOYER SUR VERCEL — cette fonction ne peut PAS tourner sur GitHub Pages
// (GitHub Pages ne sert que des fichiers statiques, pas de code serveur).
//
// Variable d'environnement à configurer sur Vercel :
//   STANCER_SECRET_KEY = ta clé privée (stest_xxx en test, sprod_xxx en production)
// Ne JAMAIS mettre cette clé dans un fichier committé sur GitHub.

const STANCER_API_BASE = 'https://api.stancer.com/v2'; // confirmé par la doc officielle Stancer

// Tarifs des prestations — gardés ici, côté serveur, pour que le montant
// ne puisse jamais être modifié depuis le navigateur du client.
const PRODUCTS = {
  mensuelle: { amount: 3499, label: 'Guidance Mensuelle', currency: 'eur' },
  personnalisee: { amount: 3999, label: 'Guidance Personnalisée', currency: 'eur' },
  anniversaire: { amount: 4999, label: 'Guidance Anniversaire', currency: 'eur' },
};

export default async function handler(req, res) {
  // Autoriser les appels depuis clesdusort.fr uniquement
  res.setHeader('Access-Control-Allow-Origin', 'https://clesdusort.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  try {
    const body = req.body || {};
    // On accepte "productIds" (tableau, cas normal quand plusieurs prestations sont
    // sélectionnées) ou l'ancien "productId" (chaîne unique) pour compatibilité.
    let productIds = body.productIds;
    if (!productIds && body.productId) {
      productIds = [body.productId];
    }
    const email = body.email;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Aucune prestation sélectionnée' });
    }
    if (!email) {
      return res.status(400).json({ error: 'Email requis' });
    }

    // On élimine les doublons et on valide chaque prestation
    const uniqueIds = [...new Set(productIds)];
    const products = [];
    for (const id of uniqueIds) {
      const p = PRODUCTS[id];
      if (!p) {
        return res.status(400).json({ error: `Prestation inconnue : ${id}` });
      }
      products.push(p);
    }

    // Montant total = somme des prestations sélectionnées.
    // ⚠️ Pour la Guidance Mensuelle, ce montant ne couvre que le prélèvement du jour ;
    // cette intégration ne met pas en place de prélèvement automatique récurrent —
    // les mois suivants restent à gérer manuellement (comme c'était déjà le cas avant).
    const totalAmount = products.reduce((sum, p) => sum + p.amount, 0);
    const description = products.map(p => p.label).join(' + ');
    const currency = products[0].currency; // toutes nos prestations sont en EUR

    const secretKey = process.env.STANCER_SECRET_KEY;
    if (!secretKey) {
      return res.status(500).json({ error: 'Clé Stancer non configurée côté serveur' });
    }

    const authHeader = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

    // 1. Créer le client Stancer (customer)
    const customerRes = await fetch(`${STANCER_API_BASE}/customers/`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email }),
    });
    const customer = await customerRes.json();
    if (!customerRes.ok) {
      return res.status(502).json({ error: 'Erreur création client Stancer', details: customer });
    }

    // 2. Créer l'intention de paiement en mode "autorisation uniquement" (capture=false)
    // C'est le flux documenté par Stancer pour les paiements en ligne avec 3D Secure :
    // autorisation d'abord, capture séparée ensuite via /api/capture-payment une fois le paiement confirmé.
    const intentRes = await fetch(`${STANCER_API_BASE}/payment_intents/`, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: totalAmount,
        currency,
        customer: customer.id,
        capture: false, // autorisation uniquement — la capture se fait dans un second temps
        description,
      }),
    });
    const intent = await intentRes.json();
    if (!intentRes.ok) {
      return res.status(502).json({ error: "Erreur création de l'intention de paiement", details: intent });
    }

    // On renvoie au front uniquement ce dont il a besoin (jamais la clé secrète)
    return res.status(200).json({
      paymentIntentId: intent.id,
      hppUrl: intent.url, // URL de la page de paiement hébergée, à afficher en iframe
      totalAmount,
      description,
      products: uniqueIds,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
