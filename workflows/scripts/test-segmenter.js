// Usage: node workflows/scripts/test-segmenter.js
// Relit les vrais CSV dans data/imports/ et affiche des stats de sanité
// (comptes par catégorie, emails rejetés, exemples). Ne modifie rien,
// n'écrit rien dans data/output/ (ça, c'est le rôle du workflow n8n).
const fs = require('fs');
const path = require('path');
const {
  decodeCp1252,
  parseCsv,
  rowsToObjects,
  validateHeader,
  buildOutputs,
  REQUIRED_CLIENT_COLUMNS,
  REQUIRED_COTISANT_COLUMNS,
  REQUIRED_CA_BUREAU_COLUMNS,
} = require('./segmenter.js');

const root = path.resolve(__dirname, '..', '..');
const clientsPath = path.join(root, 'data/imports/liste_clients/liste_clients.csv');
const cotisantsPath = path.join(root, 'data/imports/cotisants/cotisants.csv');
const caBureauDir = path.join(root, 'data/imports/ca_bureau');

const clientsBuf = fs.readFileSync(clientsPath);
const cotisantsBuf = fs.readFileSync(cotisantsPath);

const clientsRawRows = parseCsv(decodeCp1252(clientsBuf), ';');
const cotisantsRawRows = parseCsv(decodeCp1252(cotisantsBuf), ';');

validateHeader(clientsRawRows, REQUIRED_CLIENT_COLUMNS, 'liste_clients.csv');
validateHeader(cotisantsRawRows, REQUIRED_COTISANT_COLUMNS, 'cotisants.csv');
console.log('Validation des colonnes: OK');

const clientsRows = rowsToObjects(clientsRawRows);
const cotisantsRows = rowsToObjects(cotisantsRawRows);

// ca_bureau.csv est optionnel : tenu à la main, pas un export ouiresa.
let caBureauRows = [];
const caBureauFile = fs.existsSync(caBureauDir)
  ? fs.readdirSync(caBureauDir).find((f) => f.toLowerCase().endsWith('.csv'))
  : null;
if (caBureauFile) {
  const caBureauBuf = fs.readFileSync(path.join(caBureauDir, caBureauFile));
  // Fichier tenu à la main : UTF-8, pas besoin du décodage Windows-1252 des exports ouiresa.
  const caBureauRawRows = parseCsv(caBureauBuf.toString('utf8'), ';');
  validateHeader(caBureauRawRows, REQUIRED_CA_BUREAU_COLUMNS, caBureauFile);
  caBureauRows = rowsToObjects(caBureauRawRows);
  console.log(`Lignes CA/Bureau: ${caBureauRows.length} (${caBureauFile})`);
} else {
  console.log('Pas de ca_bureau.csv trouvé (optionnel) — étape ignorée.');
}

console.log(`Lignes clients: ${clientsRows.length} / cotisants: ${cotisantsRows.length}`);

const { brevoRows, rejectedRows, warningRows } = buildOutputs(clientsRows, cotisantsRows, caBureauRows);

console.log(`\nContacts prets pour Brevo: ${brevoRows.length}`);
console.log(`Lignes rejetees (non categorise): ${rejectedRows.length}`);
console.log(`Lignes a verifier (envoyees a Brevo mais avec un avertissement): ${warningRows.length}`);
for (const row of warningRows.slice(0, 10)) {
  console.log(`  - ${row.EMAIL}: ${row.AVERTISSEMENT}`);
}

const catCounts = {};
for (const r of brevoRows) {
  for (const c of r.CATEGORIES.split(';')) catCounts[c] = (catCounts[c] || 0) + 1;
}
console.log('\nRepartition par categorie (un contact peut compter dans plusieurs):');
console.table(catCounts);

const raisons = {};
for (const r of rejectedRows) raisons[r.__raison] = (raisons[r.__raison] || 0) + 1;
console.log('Raisons de rejet:');
console.table(raisons);

console.log(`\nCotisation a jour: ${brevoRows.filter((r) => r.COTISATION_A_JOUR === 'oui').length} / ${brevoRows.length}`);
console.log(`Avec type de licence: ${brevoRows.filter((r) => r.TYPE_LICENCE).length}`);
console.log(`Emails groupant plusieurs personnes: ${brevoRows.filter((r) => Number(r.NB_PERSONNES_LIEES) > 1).length}`);
