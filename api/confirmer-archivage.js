// api/confirmer-archivage.js
// Appelé par l'appli locale de Carole une fois les PDF bien enregistrés sur son disque,
// pour ne plus jamais les proposer à nouveau au prochain archivage.
//
// Usage : POST /api/confirmer-archivage
// Body JSON : { "invoiceNumbers": ["2026-001", "2026-002", ...] }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée (POST uniquement)' });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return res.status(500).json({ error: 'Upstash non configuré côté serveur' });
  }

  const { invoiceNumbers } = req.body || {};
  if (!Array.isArray(invoiceNumbers) || invoiceNumbers.length === 0) {
    return res.status(400).json({ error: 'invoiceNumbers manquant ou vide' });
  }

  try {
    for (const invoiceNumber of invoiceNumbers) {
      const key = `facture_${invoiceNumber}`;
      // On supprime le contenu de la facture...
      await fetch(`${url}/del/${key}`, { headers: { Authorization: `Bearer ${token}` } });
      // ...et on la retire de la liste d'attente.
      await fetch(`${url}/srem/factures_en_attente/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    }
    return res.status(200).json({ success: true, confirmees: invoiceNumbers.length });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
