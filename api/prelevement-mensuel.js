// api/prelevement-mensuel.js
// Tâche automatique (Vercel Cron, voir vercel.json) déclenchée le 5 de chaque mois.
// Parcourt les abonnées Mensuelle enregistrées dans Upstash, tente le prélèvement de
// celles dont c'est le tour ce mois-ci (via "capture: true", méthode validée par un vrai
// test réel le 10/09/2026, suite à l'échange avec le support Stancer), génère facture +
// email pour chaque succès (réutilise les mêmes fonctions que le paiement ponctuel), puis
// envoie à Carole un email récap + le fichier JSON prêt pour son bouton "Importer statut
// paiements".
//
// ⚠️ SÉCURITÉ : ce endpoint débite de vraies cartes. Protégé par CRON_SECRET (variable
// d'environnement à ajouter sur Vercel) — Vercel l'envoie automatiquement pour ses propres
// appels programmés ; tout autre appelant sans ce secret est rejeté.

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const STANCER_API_BASE = 'https://api.stancer.com/v2';
const MONTANT_MENSUELLE_CENTIMES = 3499;
const SEUIL_ECHECS_DESACTIVATION = 3;

const EMETTEUR = {
  nom: 'Carole Mlakar',
  nomCommercial: 'Clés du Sort',
  statut: 'Entrepreneur Individuel (EI)',
  siret: 'SIRET : 107 760 522 00014',
  adresse: '11 rue Lacroix Robert, 78800 Houilles',
  mentionTva: 'TVA non applicable, art. 293 B du CGI',
};
const FROM_EMAIL = 'Clés du Sort <factures@clesdusort.fr>';
const BCC_EMAIL = 'cles.dusort@gmail.com';
const MOIS_FR = ["janvier","février","mars","avril","mai","juin","juillet","août","septembre","octobre","novembre","décembre"];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Vérification du secret (protège contre un appel externe non autorisé)
  const authHeader = req.headers['authorization'] || '';
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const kvUrl = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const secretKey = process.env.STANCER_SECRET_KEY;
  if (!kvUrl || !kvToken || !secretKey) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (Upstash/Stancer)' });
  }
  const stancerAuth = 'Basic ' + Buffer.from(secretKey + ':').toString('base64');

  try {
    const now = new Date();
    const moisActuel = now.getMonth();
    const anneeActuelle = now.getFullYear();

    // 1. Liste des abonnées actives
    const membersRes = await fetch(`${kvUrl}/smembers/abonnements_actifs`, { headers: { Authorization: `Bearer ${kvToken}` } });
    const membersData = await membersRes.json();
    const keys = membersData.result || [];

    const resultats = []; // { email, statut: 'payé'|'échoué', ... } — pour le JSON app + le récap

    for (const key of keys) {
      const getRes = await fetch(`${kvUrl}/get/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
      const getData = await getRes.json();
      if (!getData.result) continue;
      const abo = JSON.parse(getData.result);

      // Pas encore le tour de cette abonnée ce mois-ci
      if (abo.prochainMois !== moisActuel || abo.prochainAnnee !== anneeActuelle) continue;

      let succes = false;
      let captureResult = null;
      try {
        const intentRes = await fetch(`${STANCER_API_BASE}/payment_intents/`, {
          method: 'POST',
          headers: { Authorization: stancerAuth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: MONTANT_MENSUELLE_CENTIMES,
            currency: 'eur',
            customer: abo.customer,
            card: abo.card,
            capture: true,
            description: 'Mensuelle',
          }),
        });
        const intent = await intentRes.json();
        succes = intentRes.ok && intent.status === 'captured';
        captureResult = intent;
      } catch (chargeErr) {
        console.error(`Erreur prélèvement ${key} :`, chargeErr);
      }

      const prochainMoisDate = new Date(anneeActuelle, moisActuel + 1, 1);

      if (succes) {
        abo.echecsConsecutifs = 0;
        abo.prochainMois = prochainMoisDate.getMonth();
        abo.prochainAnnee = prochainMoisDate.getFullYear();

        const invoiceNumber = await getNextInvoiceNumber(anneeActuelle, kvUrl, kvToken);
        const amountEuros = (MONTANT_MENSUELLE_CENTIMES / 100).toFixed(2).replace('.', ',');
        try {
          const pdfBytes = await genererFacturePDF({ invoiceNumber, date: now, client: abo, amountEuros });
          await envoyerEmailFacture({ to: abo.email, prenom: abo.prenom, invoiceNumber, amountEuros });
          await enregistrerFacturePourArchivage({ invoiceNumber, date: now, pdfBytes, clientNom: abo.nom, kvUrl, kvToken });
        } catch (factureErr) {
          console.error(`Erreur facture/email pour ${key} (paiement déjà confirmé) :`, factureErr);
        }

        resultats.push({ email: abo.email, statut: 'payé', date_paiement: now.toLocaleDateString('fr-FR'), prochain_prelevement: `05/${String(prochainMoisDate.getMonth()+1).padStart(2,'0')}/${prochainMoisDate.getFullYear()}`, moyen_paiement: 'Carte' });

        // Si c'était son dernier prélèvement dû (résiliation en cours), on arrête là.
        if (abo.statut === 'resiliation_demandee') {
          await fetch(`${kvUrl}/srem/abonnements_actifs/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
        }
      } else {
        abo.echecsConsecutifs = (abo.echecsConsecutifs || 0) + 1;
        abo.prochainMois = prochainMoisDate.getMonth();
        abo.prochainAnnee = prochainMoisDate.getFullYear();
        resultats.push({ email: abo.email, statut: 'échoué', prochain_prelevement: `05/${String(prochainMoisDate.getMonth()+1).padStart(2,'0')}/${prochainMoisDate.getFullYear()}` });

        // Résiliation en cours OU 3 échecs consécutifs -> on arrête de retenter.
        if (abo.statut === 'resiliation_demandee' || abo.echecsConsecutifs >= SEUIL_ECHECS_DESACTIVATION) {
          await fetch(`${kvUrl}/srem/abonnements_actifs/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
        }
      }

      await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(abo),
      });
    }

    // Email récap à Carole, avec le JSON prêt pour son bouton "Importer statut paiements"
    if (resultats.length > 0) {
      await envoyerRecapCarole(resultats, MOIS_FR[moisActuel], anneeActuelle);
    }

    return res.status(200).json({ success: true, traitees: resultats.length, resultats });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue', details: String(err) });
  }
}

// ---------------------------------------------------------------------------------
async function getNextInvoiceNumber(year, kvUrl, kvToken) {
  const key = `facture_counter_${year}`;
  const incrRes = await fetch(`${kvUrl}/incr/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
  const data = await incrRes.json();
  return `${year}-${String(data.result).padStart(3, '0')}`;
}

async function genererFacturePDF({ invoiceNumber, date, client, amountEuros }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.153, 0.153, 0.34);
  const black = rgb(0.05, 0.05, 0.05);
  const gray = rgb(0.4, 0.4, 0.4);
  const dateStr = date.toLocaleDateString('fr-FR');
  let y = 780;

  page.drawText('FACTURE', { x: 50, y, size: 22, font: fontBold, color: ink });
  page.drawText(`N° ${invoiceNumber}`, { x: 400, y, size: 14, font: fontBold, color: black });
  y -= 20;
  page.drawText(`Date d'émission : ${dateStr}`, { x: 400, y, size: 10, font, color: gray });
  y -= 50;

  page.drawText('Émetteur', { x: 50, y, size: 9, font: fontBold, color: gray });
  y -= 16;
  [EMETTEUR.nom, EMETTEUR.statut, EMETTEUR.siret, EMETTEUR.adresse].forEach((ligne) => {
    page.drawText(ligne, { x: 50, y, size: 11, font, color: black });
    y -= 15;
  });
  y -= 15;

  page.drawText('Client', { x: 50, y, size: 9, font: fontBold, color: gray });
  y -= 16;
  const ligne2 = [client.codePostal, client.ville].filter(Boolean).join(' ');
  [client.nom, client.adresse, ligne2, client.pays].filter(Boolean).forEach((ligne) => {
    page.drawText(ligne, { x: 50, y, size: 11, font, color: black });
    y -= 15;
  });
  y -= 40;

  page.drawLine({ start: { x: 50, y: y + 10 }, end: { x: 545, y: y + 10 }, thickness: 1, color: gray });
  page.drawText('Description', { x: 50, y, size: 10, font: fontBold, color: black });
  page.drawText('Montant', { x: 470, y, size: 10, font: fontBold, color: black });
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: gray });
  y -= 22;
  page.drawText('Guidance Mensuelle', { x: 50, y, size: 11, font, color: black });
  page.drawText(`${amountEuros} €`, { x: 470, y, size: 11, font, color: black });
  y -= 30;

  page.drawLine({ start: { x: 50, y: y + 10 }, end: { x: 545, y: y + 10 }, thickness: 1, color: gray });
  page.drawText('Total HT', { x: 400, y, size: 12, font: fontBold, color: ink });
  page.drawText(`${amountEuros} €`, { x: 470, y, size: 12, font: fontBold, color: ink });
  y -= 40;

  page.drawText('Payé automatiquement par carte bancaire (prélèvement mensuel).', { x: 50, y, size: 10, font, color: gray });
  y -= 40;
  page.drawText(EMETTEUR.mentionTva, { x: 50, y, size: 9, font, color: gray });
  y -= 14;
  page.drawText('Facture émise sans TVA, en franchise en base (article 293 B du Code général des impôts).', { x: 50, y, size: 9, font, color: gray });

  return await pdfDoc.save();
}

async function envoyerEmailFacture({ to, prenom, invoiceNumber, amountEuros }) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) throw new Error('RESEND_API_KEY manquante');
  const salutation = prenom ? `Bonjour ${prenom}` : 'Bonjour';

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [to],
      bcc: [BCC_EMAIL],
      subject: `C'est confirmé ✨ — ta lettre de ce mois-ci est en préparation`,
      html: `
        <p>${salutation}</p>
        <p>C'est noté, et c'est confirmé : ton paiement pour la Guidance Mensuelle (${amountEuros} €) est bien passé.</p>
        <p>Ta lettre de ce mois-ci est en préparation. Elle prendra la route vers ta boîte aux lettres bientôt !</p>
        <p>Le prélèvement suivant aura lieu automatiquement le 5 du mois prochain, sans que tu aies à refaire quoi que ce soit.</p>
        <p>À très vite,<br>Clés du Sort.</p>
        <p style="font-size:12px; color:#888; margin-top:24px;">Ceci est un message automatique, merci de ne pas y répondre directement. Pour toute question, contacte-nous à cles.dusort@gmail.com.</p>
      `,
    }),
  });
  const data = await emailRes.json();
  if (!emailRes.ok) throw new Error('Erreur envoi email Resend : ' + JSON.stringify(data));
}

async function enregistrerFacturePourArchivage({ invoiceNumber, date, pdfBytes, clientNom, kvUrl, kvToken }) {
  const pdfBase64 = Buffer.from(pdfBytes).toString('base64');
  const moisNom = MOIS_FR[date.getMonth()];
  const moisCapitalise = moisNom.charAt(0).toUpperCase() + moisNom.slice(1);
  const record = JSON.stringify({ invoiceNumber, annee: date.getFullYear(), mois: moisCapitalise, clientNom: clientNom || '', pdfBase64 });
  await fetch(`${kvUrl}/set/facture_${invoiceNumber}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
    body: record,
  });
  await fetch(`${kvUrl}/sadd/factures_en_attente/facture_${invoiceNumber}`, { headers: { Authorization: `Bearer ${kvToken}` } });
}

async function envoyerRecapCarole(resultats, moisNom, annee) {
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return;
  const payes = resultats.filter(r => r.statut === 'payé');
  const echoues = resultats.filter(r => r.statut === 'échoué');

  const jsonPourApp = { mois: moisNom.charAt(0).toUpperCase() + moisNom.slice(1), annee: String(annee), paiements: resultats };
  const jsonBase64 = Buffer.from(JSON.stringify(jsonPourApp, null, 2)).toString('base64');

  const listeEchoues = echoues.length
    ? `<p>❌ ${echoues.length} paiement(s) échoué(s) :</p><ul>${echoues.map(e => `<li>${e.email}</li>`).join('')}</ul>`
    : '';

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [BCC_EMAIL],
      subject: `Prélèvements du 5 ${moisNom} ${annee} — récapitulatif`,
      html: `
        <p>Bonjour,</p>
        <p>Voici le récapitulatif des prélèvements automatiques du mois :</p>
        <p>✅ ${payes.length} paiement(s) réussi(s)</p>
        ${listeEchoues}
        <p>Le fichier à importer dans ton appli ("🔄 Importer statut paiements") est en pièce jointe.</p>
      `,
      attachments: [{ filename: `paiements_${moisNom}_${annee}.json`, content: jsonBase64 }],
    }),
  });
}
