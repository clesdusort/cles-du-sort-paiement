// api/factures-en-attente.js
// Renvoie la liste de toutes les factures pas encore archivées dans l'appli locale de Carole.
// Appelé par le bouton "📁 Archiver les factures" de son appli.
//
// Usage : GET /api/factures-en-attente

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Méthode non autorisée (GET uniquement)' });
  }

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    return res.status(500).json({ error: 'Upstash non configuré côté serveur' });
  }

  try {
    // 1. Liste des identifiants de factures en attente
    const membersRes = await fetch(`${url}/smembers/factures_en_attente`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const membersData = await membersRes.json();
    const ids = membersData.result || [];

    if (ids.length === 0) {
      return res.status(200).json({ factures: [] });
    }

    // 2. On récupère le contenu de chaque facture
    const factures = [];
    for (const id of ids) {
      const getRes = await fetch(`${url}/get/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const getData = await getRes.json();
      if (getData.result) {
        try {
          const record = JSON.parse(getData.result);
          factures.push(record);
        } catch (e) {
          console.error(`Facture ${id} illisible, ignorée :`, e);
        }
      }
    }

    return res.status(200).json({ factures });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Erreur serveur inattendue' });
  }
}
