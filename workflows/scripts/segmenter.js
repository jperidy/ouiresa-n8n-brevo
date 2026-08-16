'use strict';

// Logique de segmentation clients -> Brevo, testée en Node.js standalone
// puis copiée telle quelle dans le nœud "Code" du workflow n8n
// "01 - Générer fichiers Brevo" (voir workflows/01-generer-fichiers-brevo.json).
// Ce fichier n'est PAS exécuté par n8n directement : c'est la référence
// lisible/versionnable/testable. Si tu modifies la logique, modifie ici,
// teste avec `node workflows/scripts/test-segmenter.js`, puis reporte le
// changement dans le nœud Code du workflow (copier les fonctions ci-dessous,
// sans le bloc module.exports, à la suite du code de lecture des fichiers).

// ==== CONFIG (à ajuster si besoin) ====
const EMAIL_BLOCKLIST = new Set(['blabla@gmail.com']);
const PLACEHOLDER_LOCAL_PARTS = /^(test|xxx+|aaa+|none|na|inconnu|sansemail|noemail|exemple|example)$/i;

function getCurrentYear() {
  return new Date().getFullYear().toString();
}

// Les CSV exportés par ouiresa sont en Windows-1252, pas UTF-8 (accents/apostrophes
// typographiques cassés sinon). Buffer.toString('latin1') ne suffit pas : les octets
// 0x80-0x9F diffèrent entre ISO-8859-1 et Windows-1252 (ex: 0x92 = apostrophe courbe).
const CP1252_HIGH = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
};

function decodeCp1252(buffer) {
  let out = '';
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    out += String.fromCodePoint(CP1252_HIGH[b] || b);
  }
  return out;
}

// ==== Parseur CSV générique (gère guillemets, champs vides, CRLF, retours à
// la ligne à l'intérieur d'un champ entre guillemets) ====
function parseCsv(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function rowsToObjects(rows) {
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, i) => {
      obj[h] = (r[i] ?? '').trim();
    });
    return obj;
  });
}

// Garde-fou contre un changement de format de l'export ouiresa (colonne
// renommee/supprimee) : sans ca, le script continuerait a tourner en
// silence avec des valeurs undefined partout et classerait tout le monde
// en "autre" sans erreur visible.
const REQUIRED_CLIENT_COLUMNS = [
  'Type', 'Type pers. morale', 'Raison sociale', 'Personne référente', 'Civilité',
  'Nom', 'Prénom', 'Email', 'Mobile', 'Téléphone', 'Adresse 1', 'Adresse 2',
  'Code postal', 'Ville', 'Pays',
];
const REQUIRED_COTISANT_COLUMNS = ['Email', 'Année', 'Type', 'Titre'];

function validateHeader(rows, requiredColumns, label) {
  const header = (rows[0] || []).map((h) => h.trim());
  const missing = requiredColumns.filter((c) => !header.includes(c));
  if (missing.length > 0) {
    throw new Error(
      `Colonnes manquantes dans ${label}: ${missing.join(', ')}. L'export ouiresa a peut-etre change de format.`
    );
  }
}

// Types de cotisation/licence connus au moment de l'ecriture de ce script
// (constate sur l'export reel). Une valeur non reconnue ne fait pas
// echouer l'import mais declenche un avertissement de revue.
const KNOWN_COTISATION_TYPES = new Set([
  'Cotisation club',
  'Passeport Voile - FFV',
  'Licence Club FFVoile Adulte',
  'Licence Club FFVoile Jeune',
]);

function stripAccents(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function norm(s) {
  return stripAccents(s || '').toLowerCase().trim();
}

function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

function isValidEmailFormat(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

// Certaines lignes source ont un email recopié par erreur dans le champ Ville
// (constaté sur l'export réel : 3 lignes). On neutralise plutôt que d'importer une
// ville invalide dans Brevo.
function sanitizeCityField(v) {
  return v && v.includes('@') ? '' : v;
}

// Brevo rejette (ou ignore) un numero qui n'est pas dans un format valide.
// On normalise vers E.164 (+33...) et on renvoie une valeur vide plutot
// qu'un numero bancal si on ne peut pas le convertir avec confiance --
// mieux vaut un attribut absent qu'une valeur qui fait echouer l'appel API.
function normalizePhone(raw, countryHint) {
  if (!raw) return { value: '', ok: true, raw: raw || '' };

  let digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return { value: '', ok: false, raw };

  const digitsOnly = digits.replace(/^\+/, '');
  // Numeros placeholder (0000000000, 1111111...): un seul chiffre repete.
  if (/^(\d)\1+$/.test(digitsOnly)) return { value: '', ok: false, raw };

  const country = (countryHint || '').trim().toUpperCase();
  const isFrance = country === '' || country === 'FR' || country === 'FRANCE';

  if (digits.startsWith('00')) {
    digits = '+' + digits.slice(2);
  } else if (digits.startsWith('+')) {
    // deja au format international, on le garde tel quel
  } else if (digits.startsWith('0')) {
    if (!isFrance) {
      // format local pour un pays non-FR : pas de regle fiable, on ne devine pas
      return { value: '', ok: false, raw };
    }
    digits = '+33' + digits.slice(1);
  } else {
    return { value: '', ok: false, raw };
  }

  if (!/^\+[1-9]\d{6,14}$/.test(digits)) {
    return { value: '', ok: false, raw };
  }
  return { value: digits, ok: true, raw };
}

function isBlockedEmail(e) {
  if (EMAIL_BLOCKLIST.has(e)) return true;
  const localPart = e.split('@')[0] || '';
  if (PLACEHOLDER_LOCAL_PARTS.test(localPart)) return true;
  return false;
}

const CATEGORY_PRIORITY = ['ecole', 'entreprise', 'cotisant_annuel', 'cotisant_saisonnier', 'autre'];

function buildOutputs(clientsRows, cotisantsRows, currentYear) {
  currentYear = currentYear || getCurrentYear();

  const cotisationsByEmail = new Map();
  for (const row of cotisantsRows) {
    const email = normalizeEmail(row['Email']);
    if (!email) continue;
    if (!cotisationsByEmail.has(email)) cotisationsByEmail.set(email, []);
    cotisationsByEmail.get(email).push(row);
  }

  const clientsByEmail = new Map();
  const rejected = [];

  for (const row of clientsRows) {
    const rawEmail = row['Email'];
    const email = normalizeEmail(rawEmail);
    if (!email || !isValidEmailFormat(email)) {
      rejected.push({ ...row, __raison: !rawEmail ? 'Email manquant' : 'Email invalide' });
      continue;
    }
    if (isBlockedEmail(email)) {
      rejected.push({ ...row, __raison: 'Email suspect / placeholder probable (partagé par de nombreuses personnes non liées)' });
      continue;
    }
    if (!clientsByEmail.has(email)) clientsByEmail.set(email, []);
    clientsByEmail.get(email).push(row);
  }

  const brevoRows = [];
  for (const [email, people] of clientsByEmail.entries()) {
    const cotisationRows = cotisationsByEmail.get(email) || [];
    const currentYearCotisations = cotisationRows.filter((r) => r['Année'] === currentYear);

    const isEcole = people.some((p) => norm(p['Type pers. morale']).includes('ecole'));
    const isEntreprise = people.some((p) => norm(p['Type pers. morale']).includes('entreprise'));
    const hasAnnuel = currentYearCotisations.some((r) => norm(r['Titre']).includes('annuelle'));
    const hasSaisonnier = currentYearCotisations.some((r) => norm(r['Titre']).includes('estival'));

    const categories = [];
    if (isEcole) categories.push('ecole');
    if (isEntreprise) categories.push('entreprise');
    if (hasAnnuel) categories.push('cotisant_annuel');
    if (hasSaisonnier) categories.push('cotisant_saisonnier');
    if (categories.length === 0) categories.push('autre');

    const cotisationAJour = hasAnnuel || hasSaisonnier;

    const licenseTitles = Array.from(
      new Set(
        cotisationRows
          .filter((r) => norm(r['Type']).includes('passeport') || norm(r['Type']).includes('licence'))
          .map((r) => r['Titre'])
          .filter(Boolean)
      )
    );

    const warnings = [];
    const unknownTypes = Array.from(new Set(cotisationRows.map((r) => r['Type']).filter((t) => t && !KNOWN_COTISATION_TYPES.has(t))));
    if (unknownTypes.length > 0) {
      warnings.push(`Type de cotisation non reconnu: ${unknownTypes.join(', ')}`);
    }

    const scored = people.map((p) => {
      const pCats = [];
      if (norm(p['Type pers. morale']).includes('ecole')) pCats.push('ecole');
      if (norm(p['Type pers. morale']).includes('entreprise')) pCats.push('entreprise');
      const rank = pCats.length ? CATEGORY_PRIORITY.findIndex((c) => pCats.includes(c)) : CATEGORY_PRIORITY.length;
      return { p, rank };
    });
    scored.sort((a, b) => a.rank - b.rank);
    const primary = scored[0].p;
    const others = people.filter((p) => p !== primary);

    const nom = primary['Type'] === 'Personne morale' && primary['Raison sociale'] ? primary['Raison sociale'] : primary['Nom'];
    const prenom = primary['Type'] === 'Personne morale' ? '' : primary['Prénom'];

    const rawPhone = primary['Mobile'] || primary['Téléphone'] || '';
    const phone = normalizePhone(rawPhone, primary['Pays']);
    if (rawPhone && !phone.ok) {
      warnings.push(`Telephone invalide/non normalisable: "${rawPhone}"`);
    }

    brevoRows.push({
      EMAIL: email,
      NOM: nom,
      PRENOM: prenom,
      CIVILITE: primary['Civilité'] || '',
      PERSONNE_REFERENTE: primary['Personne référente'] || '',
      ADRESSE: Array.from(new Set([primary['Adresse 1'], primary['Adresse 2']].filter(Boolean))).join(' '),
      CODE_POSTAL: primary['Code postal'] || '',
      VILLE: sanitizeCityField(primary['Ville']),
      PAYS: primary['Pays'] || '',
      TELEPHONE: phone.value,
      CATEGORIES: categories.join(';'),
      COTISATION_A_JOUR: cotisationAJour ? 'oui' : 'non',
      ANNEE_COTISATION: currentYear,
      TYPE_LICENCE: licenseTitles.join('; '),
      NB_PERSONNES_LIEES: String(people.length),
      AUTRES_PERSONNES: others.map((p) => `${p['Prénom']} ${p['Nom']}`.trim()).join('; '),
      __avertissements: warnings,
    });
  }

  // Brevo attend un numero unique par contact : un meme telephone normalise
  // sur deux emails differents doit etre signale plutot que d'echouer en
  // silence au moment de l'appel API.
  // Brevo traite l'attribut SMS comme un identifiant unique (comme l'email) :
  // envoyer le meme numero pour deux contacts differents fait echouer l'appel
  // API du second (erreur "duplicate_identifiers"). On ne garde le numero que
  // sur le premier contact rencontre et on vide les autres plutot que de
  // laisser echouer l'import a chaque execution.
  const phoneSeenCount = new Map();
  for (const row of brevoRows) {
    if (!row.TELEPHONE) continue;
    const occurrence = (phoneSeenCount.get(row.TELEPHONE) || 0) + 1;
    phoneSeenCount.set(row.TELEPHONE, occurrence);
    if (occurrence > 1) {
      row.__avertissements.push(
        `Telephone ${row.TELEPHONE} partage avec un autre contact Brevo -- vide ici pour eviter un rejet API (le premier contact rencontre garde la valeur)`
      );
      row.TELEPHONE = '';
    }
  }

  const warningRows = brevoRows
    .filter((row) => row.__avertissements.length > 0)
    .map((row) => ({ ...row, AVERTISSEMENT: row.__avertissements.join(' | ') }));

  for (const row of brevoRows) delete row.__avertissements;
  for (const row of warningRows) delete row.__avertissements;

  return { brevoRows, rejectedRows: rejected, warningRows };
}

function csvEscape(value, delimiter) {
  const s = value === undefined || value === null ? '' : String(value);
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function toCsv(rows, delimiter) {
  delimiter = delimiter || ';';
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(delimiter)];
  for (const row of rows) {
    lines.push(headers.map((h) => csvEscape(row[h], delimiter)).join(delimiter));
  }
  return lines.join('\r\n');
}

module.exports = {
  decodeCp1252,
  parseCsv,
  rowsToObjects,
  validateHeader,
  buildOutputs,
  toCsv,
  normalizeEmail,
  isValidEmailFormat,
  isBlockedEmail,
  normalizePhone,
  getCurrentYear,
  REQUIRED_CLIENT_COLUMNS,
  REQUIRED_COTISANT_COLUMNS,
};
