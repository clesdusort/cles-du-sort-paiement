// api/capture-payment.js
// Fonction serverless (Vercel) : confirme et capture un paiement Stancer, PUIS génère et
// envoie automatiquement la facture correspondante par email.
//
// Flux Stancer (déjà validé par un vrai test de bout en bout) :
//   1. GET  /v2/payment_intents/<pi_id>          → vérifie que le statut est "authorized"
//   2. POST /v2/payment_intents/<pi_id>/capture  → déclenche la capture réelle des fonds
//
// ⚠️ IMPORTANT : la génération/l'envoi de la facture est encapsulée dans son propre bloc
// try/catch, séparé de la capture elle-même. Si la facture échoue pour une raison quelconque
// (Resend en panne, Upstash indisponible...), le paiement reste malgré tout confirmé côté
// cliente — on ne veut jamais qu'un souci de facturation fasse croire à un échec de paiement
// qui a en réalité réussi.
//
// Variables d'environnement nécessaires (en plus de STANCER_SECRET_KEY déjà en place) :
//   RESEND_API_KEY       — clé API Resend (Dashboard Resend → API Keys)
//   KV_REST_API_URL       — ajoutée automatiquement par l'intégration Upstash sur Vercel
//   KV_REST_API_TOKEN     — idem

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const STANCER_API_BASE = 'https://api.stancer.com/v2';

// Informations fixes de l'émetteur (Carole Mlakar / Clés du Sort), reprises des mentions légales.
const EMETTEUR = {
  nom: 'Carole Mlakar',
  statut: 'Entrepreneur Individuel (EI)',
  siret: 'SIRET : 107 760 522 00014',
  adresse: '11 rue Lacroix Robert, 78800 Houilles',
  mentionTva: 'TVA non applicable, art. 293 B du CGI',
};

const FROM_EMAIL = 'Clés du Sort <factures@clesdusort.fr>';
const BCC_EMAIL = 'cles.dusort@gmail.com'; // copie systématique pour Carole (archive + suivi)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://clesdusort.fr');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });

  try {
    const { paymentIntentId, email, client, products, cadeau } = req.body || {};
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

    // ⚠️ Idempotence : si ce paiement a déjà été capturé (ex. double appel de capture-payment
    // pour la même intention — même quelques millisecondes d'écart), on ne doit surtout PAS
    // regénérer une facture ni renvoyer un email une deuxième fois. On confirme juste le succès.
    const statutsDejaTraites = ['captured', 'to_capture', 'capture_sent'];
    if (statutsDejaTraites.includes(intent.status)) {
      return res.status(200).json({
        success: true,
        status: intent.status,
        amount: intent.amount,
        description: intent.description,
        facture: { dejaEnvoyee: true },
      });
    }

    if (intent.status !== 'authorized') {
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

    // 3. Facture : génération + envoi. Ne doit JAMAIS faire échouer la confirmation du
    // paiement (déjà acquis à ce stade) même en cas de problème sur cette partie.
    let factureInfo = null;
    if (email) {
      try {
        const year = new Date().getFullYear();
        const invoiceNumber = await getNextInvoiceNumber(year);
        const amountCents = captureResult.amount || intent.amount || 0;
        const amountEuros = (amountCents / 100).toFixed(2).replace('.', ',');
        // ⚠️ captureResult.description est la version COURTE (ex. "Mensuelle + Anniversaire"),
        // imposée par la limite de 64 caractères de Stancer — jamais montrée à la cliente.
        // Pour l'email et la facture, on reconstruit une version complète ("Guidance Mensuelle...")
        // à partir de la vraie liste des produits.
        const description = (Array.isArray(products) && products.length)
          ? products.map((id) => LABELS_PRODUITS[id] || id).join(' + ')
          : (captureResult.description || intent.description || 'Guidance Clés du Sort');

        const clientInfo = client && client.nom ? client : { prenom: '', nom: email, adresse: '', codePostal: '', ville: '', pays: '' };

        // ⚠️ cadeau.produit contient le LIBELLÉ COMPLET de la prestation concernée (ex.
        // "Guidance Mensuelle"), tel que renseigné dans le formulaire — on le fait correspondre
        // à l'id interne (mensuelle/personnalisee/anniversaire) pour savoir dans quelle puce de
        // la liste des Guidances glisser la mention cadeau.
        const cadeauProduitId = (cadeau && cadeau.produit) ? PRODUIT_ID_PAR_LABEL[cadeau.produit] || null : null;
        const blocsGuidances = construireBlocsGuidances(products, new Date(), clientInfo, cadeauProduitId, cadeau);

        const pdfBytes = await genererFacturePDF({
          invoiceNumber,
          date: new Date(),
          client: clientInfo,
          description,
          amountEuros,
        });

        await envoyerEmailFacture({ to: email, prenom: clientInfo.prenom, invoiceNumber, description, amountEuros, pdfBytes, blocsGuidances, products });

        // On garde aussi une copie dans Upstash, en attente que Carole l'archive dans son
        // appli locale (bouton "📁 Archiver les factures") — jamais perdue, même si son
        // ordinateur reste éteint plusieurs jours.
        try {
          await enregistrerFacturePourArchivage({ invoiceNumber, date: new Date(), pdfBytes });
        } catch (archiveErr) {
          console.error("Erreur d'enregistrement pour archivage (facture déjà envoyée, non bloquant) :", archiveErr);
        }

        factureInfo = { invoiceNumber, envoyee: true };
      } catch (factureErr) {
        console.error('Erreur génération/envoi facture (paiement déjà confirmé, non bloquant) :', factureErr);
        factureInfo = { envoyee: false, erreur: String(factureErr) };
      }
    }

    return res.status(200).json({
      success: true,
      status: captureResult.status || 'to_capture',
      amount: captureResult.amount,
      description: captureResult.description,
      facture: factureInfo,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}

// ---------------------------------------------------------------------------------
// Délai d'arrivée de la lettre par prestation — même règle exacte que celle déjà
// utilisée dans l'appli locale de Carole (moisEligibleMensuelle) pour la Guidance
// Mensuelle : inscription le 15 inclus -> mois suivant, le 16+ -> mois d'après.
// Personnalisée/Anniversaire restent sur le délai fixe déjà annoncé sur le site
// ("environ deux semaines"), pas de date précise promise.
// ---------------------------------------------------------------------------------
const MOIS_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];
const LABELS_PRODUITS = {
  mensuelle: 'Guidance Mensuelle',
  personnalisee: 'Guidance Personnalisée',
  anniversaire: 'Guidance Anniversaire',
};

function moisPremierEnvoiMensuelle(dateCommande) {
  const jour = dateCommande.getDate();
  const decalage = jour <= 15 ? 1 : 2;
  const d = new Date(dateCommande.getFullYear(), dateCommande.getMonth() + decalage, 1);
  const moisCapitalise = MOIS_FR[d.getMonth()].charAt(0).toUpperCase() + MOIS_FR[d.getMonth()].slice(1);
  return `${moisCapitalise} ${d.getFullYear()}`;
}

// Reconstruit l'id interne (mensuelle/personnalisee/anniversaire) à partir du libellé complet
// envoyé par le formulaire pour le champ "laquelle est cadeau" (ex. "Guidance Mensuelle").
const PRODUIT_ID_PAR_LABEL = Object.fromEntries(
  Object.entries(LABELS_PRODUITS).map(([id, label]) => [label, id])
);

// Adresse "compacte" façon vraie adresse postale (code postal + ville regroupés par un espace) —
// utilisée pour l'adresse de l'acheteur.
function formatAdresseClient(personne) {
  const cpVille = [personne.codePostal, personne.ville].filter(Boolean).join(' ');
  return [personne.adresse, cpVille, personne.pays].filter(Boolean).join(', ');
}

// Adresse cadeau : chaque champ listé séparément (déjà le format utilisé jusqu'ici pour cette
// mention), avec le pays ajouté à la fin.
function formatAdresseCadeau(personne) {
  return [personne.adresse, personne.codePostal, personne.ville, personne.pays].filter(Boolean).join(', ');
}

// Un bloc = une puce complète de l'email, par Guidance commandée : délai d'arrivée + adresse de
// livraison (celle du cadeau si CETTE Guidance précise est le cadeau, sinon celle de l'acheteur)
// + mention du prélèvement automatique si c'est la Guidance Mensuelle. Tout regroupé au même
// endroit pour que ce soit lisible d'un coup d'œil, Guidance par Guidance.
function construireBlocsGuidances(products, dateCommande, client, cadeauProduitId, cadeau) {
  if (!Array.isArray(products) || products.length === 0) return [];
  return products.map((id) => {
    const label = LABELS_PRODUITS[id] || id;
    const estCadeauPourCetteGuidance = Boolean(cadeau) && cadeauProduitId === id;

    let texte;
    if (id === 'mensuelle') {
      texte = `${label} : ta première lettre arrivera en ${moisPremierEnvoiMensuelle(dateCommande)}`;
      texte += estCadeauPourCetteGuidance
        ? `. Comme c'est un cadeau, cette lettre arrivera directement chez ${cadeau.nom}, à l'adresse indiquée (${formatAdresseCadeau(cadeau)}).`
        : (client && client.nom ? ` à l'adresse suivante : ${client.nom}, ${formatAdresseClient(client)}.` : '.');
      texte += ' Le prélèvement suivant aura lieu automatiquement le 5 de chaque mois, sans que tu aies à refaire quoi que ce soit.';
    } else {
      texte = `${label} : sous environ deux semaines`;
      texte += estCadeauPourCetteGuidance
        ? `. Comme c'est un cadeau, cette lettre arrivera directement chez ${cadeau.nom}, à l'adresse indiquée (${formatAdresseCadeau(cadeau)}).`
        : (client && client.nom ? `, à l'adresse suivante : ${client.nom}, ${formatAdresseClient(client)}.` : '.');
    }
    return texte;
  });
}


// via Upstash Redis (INCR est une opération atomique — fiable même si deux paiements
// arrivent au même moment).
// ---------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------
// Stocke temporairement le PDF de la facture dans Upstash, en attendant que Carole
// l'archive dans son appli locale (Année/Mois). Retiré de la liste d'attente une fois
// confirmé récupéré — voir api/factures-en-attente.js et api/confirmer-archivage.js.
// ---------------------------------------------------------------------------------
async function enregistrerFacturePourArchivage({ invoiceNumber, date, pdfBytes }) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Upstash non configuré');
  }
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  const moisNom = MOIS_FR[date.getMonth()];
  const moisCapitalise = moisNom.charAt(0).toUpperCase() + moisNom.slice(1);
  const record = JSON.stringify({
    invoiceNumber,
    annee: date.getFullYear(),
    mois: moisCapitalise,
    pdfBase64,
  });

  // On stocke le contenu de la facture...
  // ⚠️ `record` est DÉJÀ une chaîne JSON (JSON.stringify plus haut) : l'API Upstash attend
  // cette valeur brute comme body, pas une seconde couche de JSON.stringify (sinon chaque
  // guillemet se retrouve échappé une fois de trop -> "double encodage").
  await fetch(`${url}/set/facture_${invoiceNumber}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: record,
  });
  // ...et on ajoute son identifiant à la liste des factures en attente d'archivage.
  await fetch(`${url}/sadd/factures_en_attente/facture_${invoiceNumber}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function getNextInvoiceNumber(year) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error("Upstash non configuré (variables KV_REST_API_URL / KV_REST_API_TOKEN manquantes)");
  }
  const key = `facture_counter_${year}`;
  const incrRes = await fetch(`${url}/incr/${key}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await incrRes.json();
  if (!incrRes.ok || typeof data.result !== 'number') {
    throw new Error('Erreur Upstash lors de l\'incrémentation du compteur : ' + JSON.stringify(data));
  }
  return `${year}-${String(data.result).padStart(3, '0')}`;
}

// ---------------------------------------------------------------------------------
// Génération du PDF de facture (mentions légales obligatoires pour un auto-entrepreneur
// en franchise en base de TVA, vente B2C > 25€).
// ---------------------------------------------------------------------------------
async function genererFacturePDF({ invoiceNumber, date, client, description, amountEuros }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4 en points
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.153, 0.153, 0.34); // #272757, couleur du site
  const black = rgb(0.05, 0.05, 0.05);
  const gray = rgb(0.4, 0.4, 0.4);

  const dateStr = date.toLocaleDateString('fr-FR');
  let y = 780;

  // Titre
  page.drawText('FACTURE', { x: 50, y, size: 22, font: fontBold, color: ink });
  page.drawText(`N° ${invoiceNumber}`, { x: 400, y, size: 14, font: fontBold, color: black });
  y -= 20;
  page.drawText(`Date d'émission : ${dateStr}`, { x: 400, y, size: 10, font, color: gray });
  y -= 50;

  // Bloc émetteur
  page.drawText('Émetteur', { x: 50, y, size: 9, font: fontBold, color: gray });
  y -= 16;
  [EMETTEUR.nom, EMETTEUR.statut, EMETTEUR.siret, EMETTEUR.adresse].forEach((ligne) => {
    page.drawText(ligne, { x: 50, y, size: 11, font, color: black });
    y -= 15;
  });

  y -= 15;

  // Bloc client
  page.drawText('Client', { x: 50, y, size: 9, font: fontBold, color: gray });
  y -= 16;
  const adresseClientLigne2 = [client.codePostal, client.ville].filter(Boolean).join(' ');
  const lignesClient = [client.nom, client.adresse, adresseClientLigne2, client.pays].filter(Boolean);
  lignesClient.forEach((ligne) => {
    page.drawText(ligne, { x: 50, y, size: 11, font, color: black });
    y -= 15;
  });

  y -= 40;

  // Tableau prestation
  page.drawLine({ start: { x: 50, y: y + 10 }, end: { x: 545, y: y + 10 }, thickness: 1, color: gray });
  page.drawText('Description', { x: 50, y, size: 10, font: fontBold, color: black });
  page.drawText('Montant', { x: 470, y, size: 10, font: fontBold, color: black });
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: gray });
  y -= 22;

  page.drawText(description, { x: 50, y, size: 11, font, color: black, maxWidth: 380 });
  page.drawText(`${amountEuros} €`, { x: 470, y, size: 11, font, color: black });
  y -= 30;

  page.drawLine({ start: { x: 50, y: y + 10 }, end: { x: 545, y: y + 10 }, thickness: 1, color: gray });
  page.drawText('Total HT', { x: 400, y, size: 12, font: fontBold, color: ink });
  page.drawText(`${amountEuros} €`, { x: 470, y, size: 12, font: fontBold, color: ink });
  y -= 40;

  page.drawText('Payé comptant par carte bancaire.', { x: 50, y, size: 10, font, color: gray });
  y -= 40;

  // Mentions légales
  page.drawText(EMETTEUR.mentionTva, { x: 50, y, size: 9, font, color: gray });
  y -= 14;
  page.drawText('Facture émise sans TVA, en franchise en base (article 293 B du Code général des impôts).', {
    x: 50, y, size: 9, font, color: gray,
  });

  return await pdfDoc.save();
}

// ---------------------------------------------------------------------------------
// Envoi de l'email de confirmation + facture jointe, via l'API Resend. Toujours en
// copie cachée à Carole (archive personnelle + trace de chaque envoi).
// ---------------------------------------------------------------------------------
async function envoyerEmailFacture({ to, prenom, invoiceNumber, description, amountEuros, pdfBytes, blocsGuidances, products }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    throw new Error('Clé Resend non configurée (RESEND_API_KEY manquante)');
  }
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  const pluriel = Array.isArray(products) && products.length > 1;
  const salutation = prenom ? `Bonjour ${prenom}` : 'Bonjour';

  // Chaque Guidance a sa propre puce (délai + adresse de livraison + mention prélèvement le
  // cas échéant), pour que tout soit lisible Guidance par Guidance plutôt qu'éclaté en
  // plusieurs paragraphes séparés.
  const listeGuidancesHtml = (blocsGuidances && blocsGuidances.length)
    ? `<ul>${blocsGuidances.map((ligne) => `<li>${ligne}</li>`).join('')}</ul>`
    : '';

  const descriptionAvecArticle = (Array.isArray(products) && products.length)
    ? products.map((id) => `la ${LABELS_PRODUITS[id] || id}`).join(' + ')
    : description;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      bcc: [BCC_EMAIL],
      subject: pluriel ? `C'est confirmé ✨ — tes lettres sont en préparation` : `C'est confirmé ✨ — ta lettre est en préparation`,
      html: `
        <p>${salutation}</p>
        <p>C'est noté, et c'est confirmé : ton paiement pour <strong>${descriptionAvecArticle}</strong> (${amountEuros} €) est bien passé. Ta facture est en pièce jointe, pour tes archives.</p>
        <p>${pluriel ? 'Voici quand tu peux attendre tes lettres' : 'Voici quand tu peux attendre ta lettre'} :</p>
        ${listeGuidancesHtml}
        <p>${pluriel ? "De mon côté, je m'attelle déjà à tes lettres. Elles prendront la route vers ta boîte aux lettres bientôt !" : "De mon côté, je m'attelle déjà à ta lettre. Elle prendra la route vers ta boîte aux lettres bientôt !"}</p>
        <p>À très vite,<br>Clés du Sort.</p>
        <p style="font-size:12px; color:#888; margin-top:24px;">Ceci est un message automatique, merci de ne pas y répondre directement. Pour toute question, contacte-nous à cles.dusort@gmail.com.</p>
      `,
      attachments: [
        { filename: `Facture_${invoiceNumber}.pdf`, content: pdfBase64 },
      ],
    }),
  });

  const data = await emailRes.json();
  if (!emailRes.ok) {
    throw new Error('Erreur envoi email Resend : ' + JSON.stringify(data));
  }
  return data;
}
