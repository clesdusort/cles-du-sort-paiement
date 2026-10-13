// api/_promo.js
// Fonctions partagées pour les codes promo (le "_" au début empêche Vercel d'en faire
// une adresse publique : ce fichier n'est utilisé que par les autres fonctions).
//
// Règles :
//   - BIENVENUE10 = -10 % sur le total du panier, BIENVENUE15 = -15 %
//   - 1 seule utilisation de code promo par adresse email (tous codes confondus)
//   - la remise ne s'applique qu'au paiement passé sur le site : le prélèvement mensuel
//     du 5 (prelevement-mensuel.js) reste à 36 € fixes, il n'est pas concerné.
//
// Pour ajouter / retirer un code : modifier CODES_PROMO ci-dessous puis redéployer.

import process from 'node:process';

export const CODES_PROMO = {
  BIENVENUE10: 10, // pourcentage de remise
  BIENVENUE15: 15,
};

const CLE_EMAILS_UTILISES = 'promo_emails_utilises';

export function normaliserCode(code) {
  return String(code || '').trim().toUpperCase();
}

// Normalise l'email pour éviter les contournements triviaux : casse, "+alias", points Gmail.
export function normaliserEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const parts = e.split('@');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return e;
  let local = parts[0].split('+')[0];
  let domain = parts[1];
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}

// Remise en centimes (entier). Tous les tarifs étant des multiples de 1 €, le résultat
// est toujours exact ; Math.round sert de garde-fou si un tarif change un jour.
export function calculerRemise(totalCentimes, pourcentage) {
  return Math.round((totalCentimes * pourcentage) / 100);
}

// Appel Upstash via la forme "commande en tableau JSON" (valable pour toutes les commandes).
export async function kv(commande) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Upstash non configuré');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commande),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Erreur Upstash : ' + JSON.stringify(data));
  return data.result;
}

export async function emailDejaUtilise(email) {
  const r = await kv(['SISMEMBER', CLE_EMAILS_UTILISES, normaliserEmail(email)]);
  return r === 1;
}

export async function marquerEmailUtilise(email) {
  await kv(['SADD', CLE_EMAILS_UTILISES, normaliserEmail(email)]);
}

// Vérifie un code. Renvoie toujours un objet { valide, ... } ; ne lève jamais d'exception
// pour un simple code invalide. emailRequis=true côté création du paiement (contrôle final).
export async function verifierCode({ code, email, emailRequis }) {
  const c = normaliserCode(code);
  const pourcentage = CODES_PROMO[c];
  if (!pourcentage) {
    return { valide: false, message: "Ce code n'est pas valide." };
  }
  if (email) {
    if (await emailDejaUtilise(email)) {
      return { valide: false, message: 'Un code promo a déjà été utilisé avec cette adresse email.' };
    }
  } else if (emailRequis) {
    return { valide: false, message: 'Email requis pour utiliser un code promo.' };
  }
  return { valide: true, code: c, pourcentage };
}
