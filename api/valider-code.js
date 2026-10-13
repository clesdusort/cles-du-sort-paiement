// api/valider-code.js
// Vérifie un code promo saisi par la cliente sur la page de paiement, et renvoie le
// pourcentage de remise s'il est valide. NE MARQUE RIEN comme utilisé : le code n'est
// compté qu'après un paiement réellement capturé (voir capture-payment.js).
// Le contrôle final est refait côté serveur à la création du paiement (create-payment.js).
//
// Usage : POST /api/valider-code
// Body JSON : { "code": "BIENVENUE10", "email": "cliente@exemple.com" }  (email optionnel ici)

import { verifierCode } from './_promo.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://clesdusort.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { code, email } = req.body || {};
    if (!code) {
      return res.status(400).json({ valide: false, message: 'Merci de saisir un code.' });
    }
    const resultat = await verifierCode({ code, email, emailRequis: false });
    if (!resultat.valide) {
      return res.status(200).json({ valide: false, message: resultat.message });
    }
    return res.status(200).json({ valide: true, code: resultat.code, pourcentage: resultat.pourcentage });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ valide: false, message: 'Impossible de vérifier le code pour le moment. Réessaie dans un instant.' });
  }
}
