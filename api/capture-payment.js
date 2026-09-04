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
    const { paymentIntentId, email, client } = req.body || {};
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
        const description = captureResult.description || intent.description || 'Guidance Clés du Sort';

        const clientInfo = client && client.nom ? client : { prenom: '', nom: email, adresse: '', codePostal: '', ville: '', pays: '' };

        const pdfBytes = await genererFacturePDF({
          invoiceNumber,
          date: new Date(),
          client: clientInfo,
          description,
          amountEuros,
        });

        await envoyerEmailFacture({ to: email, prenom: clientInfo.prenom, invoiceNumber, description, amountEuros, pdfBytes });
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
// Compteur de facture séquentiel, sans trou ni doublon (obligation légale française),
// via Upstash Redis (INCR est une opération atomique — fiable même si deux paiements
// arrivent au même moment).
// ---------------------------------------------------------------------------------
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
  page.drawText('Total TTC', { x: 400, y, size: 12, font: fontBold, color: ink });
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
async function envoyerEmailFacture({ to, prenom, invoiceNumber, description, amountEuros, pdfBytes }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    throw new Error('Clé Resend non configurée (RESEND_API_KEY manquante)');
  }
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  const salutation = prenom ? `Bonjour ${prenom}` : 'Bonjour';

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
      subject: `C'est confirmé ✨ — ta lettre est en préparation`,
      html: `
        <p>${salutation}</p>
        <p>C'est noté, et c'est confirmé : ton paiement pour <strong>${description}</strong> (${amountEuros} €) est bien passé.</p>
        <p>Ta facture est en pièce jointe, pour tes archives.</p>
        <p>De mon côté, je m'attelle déjà à ta lettre. Elle prendra la route vers ta boîte aux lettres bientôt !</p>
        <p>À très vite,<br>Clés du Sort.</p>
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
