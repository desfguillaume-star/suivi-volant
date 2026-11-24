/**
 * Sauvegarde de l'appli La Plume Beynatoise : volants + compta (version 3)
 *
 * MISE EN SERVICE (une seule fois) :
 *   1. Déployer > Nouveau déploiement > Application web (exécuter en tant que moi, accès : tout le monde).
 *   2. Choisir la fonction « installer » dans la liste, cliquer sur Exécuter, accepter les autorisations.
 *   3. Ouvrir le « Journal d'exécution » : copier le lien de connexion, se l'envoyer par mail, l'ouvrir une fois sur le téléphone.
 * PASSATION OU LIEN PERDU : exécuter « changerCode » (nouveau lien, l'ancien cesse de fonctionner).
 *
 * - « Journal » et « JournalCompta » : sauvegarde brute, ajout seul, masquée.
 * - Une feuille par saison : « Compta 2025-2026 » et « Volants 2025-2026 ».
 * - « Bilan » : totaux par saison et par catégorie.
 *
 * Toutes les feuilles sauf les Journaux sont recalculées à la synchronisation. Ne pas les modifier à la main.
 * Le code secret n'est PAS dans ce fichier (il est dans les propriétés du script), donc rien de secret sur GitHub.
 */
var URL_APPLI = 'https://desfguillaume-star.github.io/suivi-volant/';
var NOM_DOSSIER_COPIES = 'Sauvegardes volants';
var NB_COPIES_GARDEES = 30;
var VOLANTS_PAR_TUBE = 12;
var PRIX_TUBE_DEFAUT = 23.95;

var CATEGORIES_RECETTES = ['Adhésions', 'Subventions', 'Partenariats', 'Animations et tournois', 'Divers recettes'];
var CATEGORIES_DEPENSES = ['Volants', 'Location de salle', 'Matériel', 'Affiliation et licences', 'Déplacements et tournois', 'Frais bancaires', 'Assurances', 'Divers dépenses'];
// Feuilles des versions précédentes, supprimées automatiquement (recalculées, aucune donnée propre).
var ANCIENNES_FEUILLES = ['Séances', 'Mises à disposition', 'Pas de séance', 'Opérations', 'Chèques', 'Espèces', 'Membres', 'Tableau de bord', 'Réglages'];
var PREFIXES_ANCIENS = ['Chèques ', 'Espèces '];

var EUR = '#,##0.00 "€"';
var DATE_FR = 'dd/mm/yyyy';
var COULEUR_ENTETE = '#e3f1e8';
var COULEUR_TITRE = '#2e7d4f';

var COLS_JOURNAL = ['id', 'ts', 'type', 'sid', 'date', 'joueurs', 'tubes', 'supprimee', 'prixTube', 'stockAvant', 'achetes'];

var KINDS_COMPTA = ['op', 'cheque', 'espece', 'comptage', 'membre'];
var COLS_COMPTA = ['id', 'ts', 'kind', 'key', 'data', 'supprime'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (!tokenOk_(body.token)) return json_({ ok: false, error: 'token' });
    var events = body.events || [];
    var ids = [];
    var volantsEv = [], comptaEv = [], touchees = {};
    events.forEach(function (ev) {
      if (!ev || typeof ev.id !== 'string') return;
      ids.push(ev.id); // accusé de réception
      var sa = saisonEvenement_(ev);
      if (sa) touchees[sa] = true;
      if (KINDS_COMPTA.indexOf(ev.kind) >= 0) comptaEv.push(ev); else volantsEv.push(ev);
    });
    var added = 0;
    if (volantsEv.length) added += appendVolants_(volantsEv);
    if (comptaEv.length) added += appendCompta_(comptaEv);
    SpreadsheetApp.flush();
    // Les données sont déjà dans le Journal : une erreur de mise en forme ne fait pas échouer la synchro.
    try {
      if (events.length) reconstruireTout_(Object.keys(touchees));
    } catch (errMise) {
      Logger.log('Mise en forme : ' + errMise);
    }
    return json_({ ok: true, ids: ids, added: added });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* Fonction publique pour reconstruire toutes les feuilles depuis l'éditeur (liste déroulante, puis Exécuter). */
function reconstruire() {
  reconstruireTout_(null);
}

/* ---------- Mise en service et code secret ---------- */
function codeSecret_() { return PropertiesService.getScriptProperties().getProperty('CODE') || ''; }
function tokenOk_(t) { var c = codeSecret_(); return !!c && String(t) === c; }
function nouveauCode_() { return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); }

/* À exécuter une fois après le déploiement : crée le code, la copie quotidienne, les feuilles, et affiche le lien de connexion. */
function installer() {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('CODE')) props.setProperty('CODE', nouveauCode_());
  poserCopieQuotidienne_();
  reconstruireTout_(null);
  afficherLien_();
}

/* Passation ou lien perdu : nouveau code, nouveau lien. L'ancien lien ne fonctionne plus. */
function changerCode() {
  PropertiesService.getScriptProperties().setProperty('CODE', nouveauCode_());
  afficherLien_();
}

function afficherLien_() {
  var url = '';
  try { url = ScriptApp.getService().getUrl() || ''; } catch (err) {}
  url = url.replace(/\/dev$/, '/exec');
  if (!/\/exec$/.test(url)) {
    Logger.log('⚠ Déployez d\'abord le script (Déployer > Nouveau déploiement > Application web), puis relancez cette fonction.');
    return;
  }
  Logger.log('Lien de connexion (à ouvrir UNE fois sur le téléphone, ne le partagez pas) :\n' +
    URL_APPLI + '#connexion=' + encodeURIComponent(url + '|' + codeSecret_()));
}

function poserCopieQuotidienne_() {
  var deja = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'copieDeSecurite'; });
  if (!deja) ScriptApp.newTrigger('copieDeSecurite').timeBased().everyDays(1).atHour(3).create();
}

function appendVolants_(events) {
  var sh = journal_();
  var known = {};
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { known[r[0]] = true; });
  var rows = [];
  events.forEach(function (ev) {
    if (known[ev.id]) return;
    known[ev.id] = true;
    rows.push([ev.id, ev.ts, ev.type, ev.sid || ev.rid || ev.nid || '', ev.date || '', ev.players == null ? '' : ev.players, ev.tubes == null ? '' : ev.tubes,
      ev.deleted ? 'oui' : '', ev.tubePrice == null ? '' : ev.tubePrice, ev.stockStart == null ? '' : ev.stockStart, ev.bought == null ? '' : ev.bought]);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLS_JOURNAL.length).setValues(rows);
  return rows.length;
}

function appendCompta_(events) {
  var sh = comptaJournal_();
  var known = {};
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) { known[r[0]] = true; });
  var rows = [];
  events.forEach(function (ev) {
    if (known[ev.id]) return;
    known[ev.id] = true;
    rows.push([ev.id, ev.ts, ev.kind, ev.key, JSON.stringify(ev.data || {}), ev.deleted ? 'oui' : '']);
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, COLS_COMPTA.length).setValues(rows);
  return rows.length;
}

function doGet(e) {
  if (!e || !e.parameter || !tokenOk_(e.parameter.token)) return json_({ ok: false, error: 'token' });
  return json_({ ok: true, events: readJournal_(), compta: readComptaJournal_() });
}

/* ---------- Journaux bruts (données de sauvegarde) ---------- */
function journal_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Journal');
  if (!sh) {
    sh = ss.insertSheet('Journal');
    sh.getRange(1, 1, 1, COLS_JOURNAL.length).setValues([COLS_JOURNAL]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS_JOURNAL.length).setBackground(COULEUR_ENTETE);
    // Colonnes en texte brut pour que Sheets ne transforme pas les dates.
    sh.getRange('B:B').setNumberFormat('@');
    sh.getRange('E:E').setNumberFormat('@');
  }
  return sh;
}

function readJournal_() {
  var sh = journal_(), last = sh.getLastRow();
  if (last < 2) return [];
  var out = [];
  sh.getRange(2, 1, last - 1, COLS_JOURNAL.length).getValues().forEach(function (r) {
    if (!r[0]) return;
    if (r[2] === 'settings') {
      out.push({ id: String(r[0]), ts: String(r[1]), type: 'settings',
        tubePrice: r[8] === '' ? null : Number(r[8]), stockStart: r[9] === '' ? null : Number(r[9]), bought: r[10] === '' ? 0 : Number(r[10]) });
    } else if (r[2] === 'noSession') {
      out.push({ id: String(r[0]), ts: String(r[1]), type: 'noSession', nid: String(r[3]), date: String(r[4]), deleted: r[7] === 'oui' });
    } else if (r[2] === 'restock') {
      out.push({ id: String(r[0]), ts: String(r[1]), type: 'restock', rid: String(r[3]), date: String(r[4]),
        tubes: Number(r[6]) || 0, deleted: r[7] === 'oui' });
    } else {
      out.push({ id: String(r[0]), ts: String(r[1]), type: 'session', sid: String(r[3]), date: String(r[4]),
        players: Number(r[5]) || 0, tubes: Number(r[6]) || 0, deleted: r[7] === 'oui' });
    }
  });
  return out;
}

function comptaJournal_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('JournalCompta');
  if (!sh) {
    sh = ss.insertSheet('JournalCompta');
    sh.getRange(1, 1, 1, COLS_COMPTA.length).setValues([COLS_COMPTA]).setFontWeight('bold').setBackground(COULEUR_ENTETE);
    sh.setFrozenRows(1);
  }
  return sh;
}

function readComptaJournal_() {
  var sh = comptaJournal_(), last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, COLS_COMPTA.length).getValues().filter(function (r) { return r[0]; }).map(function (r) {
    var data = {};
    try { data = JSON.parse(String(r[4])); } catch (err) {}
    return { id: String(r[0]), ts: String(r[1]), kind: String(r[2]), key: String(r[3]), data: data, deleted: r[5] === 'oui' };
  });
}

function masquerJournaux_() {
  var ss = SpreadsheetApp.getActive();
  ['Journal', 'JournalCompta'].forEach(function (nom) {
    var s = ss.getSheetByName(nom);
    if (s) { try { s.hideSheet(); } catch (err) {} }
  });
}

/* ---------- Données volants (lues depuis le Journal) ---------- */
function etatVolants_() {
  var events = readJournal_().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : 1); });
  var bySid = {}, byRid = {}, byNid = {}, tubePrice = PRIX_TUBE_DEFAUT;
  events.forEach(function (e) {
    if (e.type === 'session') bySid[e.sid] = e;
    else if (e.type === 'restock') byRid[e.rid] = e;
    else if (e.type === 'noSession') byNid[e.nid] = e;
    else tubePrice = e.tubePrice == null ? PRIX_TUBE_DEFAUT : e.tubePrice;
  });
  return {
    sessions: triParDate_(valides_(bySid)),
    restocks: triParDate_(valides_(byRid)),
    nones: triParDate_(valides_(byNid)),
    tubePrice: tubePrice
  };
}

function valides_(obj) {
  return Object.keys(obj).map(function (k) { return obj[k]; }).filter(function (e) { return !e.deleted; });
}

function triParDate_(list) {
  return list.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
}

/* ---------- Données compta (dernière version de chaque fiche) ---------- */
/* Même règles que l'appli (compta-core.js) : le test test-compta.js vérifie que les deux donnent les mêmes totaux.
 * - Un chèque reçu (recette en mode « chèque ») n'est compté qu'une fois encaissé (« pointe »).
 * - Une cotisation payée devient automatiquement une recette « Adhésions ».
 * - Les anciennes fiches « cheque » et « espece » sont relues comme des opérations. */
function donneesCompta_() { return donneesDepuis_(readComptaJournal_()); }

function donneesDepuis_(events) {
  var tries = events.slice().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : 1); });
  var latest = {};
  tries.forEach(function (e) { latest[e.kind + ':' + e.key] = e; });
  var by = { op: [], membre: [] };
  Object.keys(latest).forEach(function (k) {
    var e = latest[k];
    if (e.deleted) return;
    var d = e.data || {};
    if (e.kind === 'op') by.op.push(d);
    else if (e.kind === 'cheque') {
      if (d.statut === 'rejete') return;
      by.op.push({ date: d.date, sens: 'recette', libelle: 'Chèque ' + (d.payeur || ''), montant: d.montant, categorie: 'Divers recettes', mode: 'chèque', pointe: d.statut === 'encaisse' });
    } else if (e.kind === 'espece') {
      var rec = d.sens === 'entree';
      by.op.push({ date: d.date, sens: rec ? 'recette' : 'depense', libelle: d.libelle, montant: d.montant, categorie: rec ? 'Divers recettes' : 'Divers dépenses', mode: 'espèces', pointe: true });
    } else if (e.kind === 'membre') by.membre.push(d);
  });
  by.membre.forEach(function (m) {
    var montant = Number(m.montant) || 0;
    if (m.paye && montant > 0) {
      by.op.push({
        date: m.date, saison: normaliserSaison_(m.saison || saisonDe_(m.date)), sens: 'recette',
        categorie: 'Adhésions', libelle: 'Cotisation ' + (m.prenom || ''), montant: montant, mode: m.mode || 'virement', pointe: true
      });
    }
  });
  return by;
}

/* Saison concernée par un événement reçu (pour ne reconstruire que les feuilles touchées). */
function saisonEvenement_(ev) {
  var d = ev.data || {};
  if (ev.kind) {
    if (d.saison) return normaliserSaison_(d.saison);
    return d.date ? saisonDe_(d.date) : '';
  }
  return ev.date ? saisonDe_(ev.date) : '';
}

/* ---------- Saisons ---------- */
/* Saison : du 1er septembre au 31 août, ex. « 2025/2026 ». */
function saisonDe_(iso) {
  var p = String(iso || '').split('-');
  if (p.length !== 3) return 'Sans date';
  var y = Number(p[0]), m = Number(p[1]);
  return m >= 9 ? y + '/' + (y + 1) : (y - 1) + '/' + y;
}

function normaliserSaison_(s) {
  return String(s || '').replace('-', '/');
}

function saisonOp_(o) {
  return o.saison ? normaliserSaison_(o.saison) : saisonDe_(o.date);
}

function saisonMembre_(m) {
  return normaliserSaison_(m.saison || saisonDe_(m.date));
}

/* Nom d'onglet : « Compta 2025-2026 ». */
function nomOnglet_(base, saison) {
  return base + ' ' + saison.replace('/', '-');
}

function saisonsConnues_(etat, by) {
  var set = {};
  function ajout(s) { if (s && s !== 'Sans date') set[s] = true; }
  etat.sessions.concat(etat.restocks, etat.nones).forEach(function (x) { ajout(saisonDe_(x.date)); });
  by.op.forEach(function (o) { ajout(saisonOp_(o)); });
  by.membre.forEach(function (m) { ajout(saisonMembre_(m)); });
  return Object.keys(set).sort();
}

function estRecette_(sens) {
  return /rec|entr/.test(String(sens || '').toLowerCase());
}

/* Recette par chèque pas encore encaissée : affichée mais pas comptée. */
function enAttente_(o) {
  return estRecette_(o.sens) && o.mode === 'chèque' && !o.pointe;
}

function bilanParSaison_(by) {
  var saisons = {};
  function ligne(s) {
    if (!saisons[s]) saisons[s] = { saison: s, recettes: 0, depenses: 0, attente: 0 };
    return saisons[s];
  }
  by.op.forEach(function (o) {
    var l = ligne(saisonOp_(o)), m = Number(o.montant) || 0;
    if (enAttente_(o)) l.attente += m;
    else if (estRecette_(o.sens)) l.recettes += m;
    else l.depenses += m;
  });
  return Object.keys(saisons).sort().map(function (k) { return saisons[k]; });
}

function sommeCategorie_(by, categorie, saison, recette) {
  return by.op.reduce(function (total, o) {
    if (o.categorie === categorie && saisonOp_(o) === saison && estRecette_(o.sens) === recette && !enAttente_(o)) return total + (Number(o.montant) || 0);
    return total;
  }, 0);
}

/* Catégories du bilan : la liste de référence, plus celles trouvées dans les données (anciennes catégories). */
function categoriesBilan_(by, reference, recette) {
  var liste = reference.slice();
  by.op.forEach(function (o) {
    if (estRecette_(o.sens) === recette && o.categorie && liste.indexOf(o.categorie) < 0) liste.push(o.categorie);
  });
  return liste;
}

function somme_(arr) {
  return arr.reduce(function (a, b) { return a + b; }, 0);
}

/* ---------- Mise en forme ---------- */
/* Écrit une feuille entière : en-tête coloré, figé, filtrable, formats par colonne (numéros de colonne à partir de 1). */
function ecrireVue_(ss, nom, header, rows, formats) {
  var sh = ss.getSheetByName(nom) || ss.insertSheet(nom);
  var f = sh.getFilter();
  if (f) f.remove();
  sh.clear();
  var n = header.length;
  sh.getRange(1, 1, 1, n).setValues([header])
    .setFontWeight('bold').setBackground(COULEUR_ENTETE).setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, n).setValues(rows);
    Object.keys(formats || {}).forEach(function (col) {
      sh.getRange(2, Number(col), rows.length, 1).setNumberFormat(formats[col]);
    });
    sh.getRange(1, 1, rows.length + 1, n).createFilter();
  }
  sh.autoResizeColumns(1, n);
  return sh;
}

/* Écrit un bloc (titre + tableau) dans une feuille partagée, sans filtre. Retourne la ligne suivante. */
function ecrireBloc_(sh, r, header, rows, formats) {
  var n = header.length;
  sh.getRange(r, 1, 1, n).setValues([header]).setFontWeight('bold').setBackground(COULEUR_ENTETE).setWrap(true);
  r++;
  if (!rows.length) {
    sh.getRange(r, 1).setValue('Aucune donnée pour le moment.').setFontColor('#666666');
    return r + 2;
  }
  sh.getRange(r, 1, rows.length, n).setValues(rows);
  formats.forEach(function (fmt, i) {
    if (fmt) sh.getRange(r, i + 1, rows.length, 1).setNumberFormat(fmt);
  });
  return r + rows.length + 2;
}

function titreBloc_(sh, r, texte) {
  sh.getRange(r, 1).setValue(texte).setFontWeight('bold').setFontSize(12).setFontColor(COULEUR_TITRE);
  return r + 1;
}

/* ---------- Feuilles par saison ---------- */
function rebuildComptaSaison_(ss, saison, by) {
  var solde = 0;
  var rows = by.op.filter(function (o) { return saisonOp_(o) === saison; })
    .sort(byDate_)
    .map(function (o) {
      var m = Number(o.montant) || 0;
      var rec = estRecette_(o.sens), att = enAttente_(o);
      if (!att) solde += rec ? m : -m;
      return [dt_(o.date), o.categorie || '', o.libelle || '', o.mode || '', (rec && !att) ? m : '', rec ? '' : m, att ? m : '', solde];
    });
  ecrireVue_(ss, nomOnglet_('Compta', saison),
    ['Date', 'Catégorie', 'Description', 'Mode de paiement', 'Recette (€)', 'Dépense (€)', 'Chèque en attente (€)', 'Solde (€)'],
    rows, { 1: DATE_FR, 5: EUR, 6: EUR, 7: EUR, 8: EUR });
}

function rebuildMembresSaison_(ss, saison, by) {
  var rows = by.membre.filter(function (m) { return saisonMembre_(m) === saison; })
    .sort(function (a, b) { return String(a.prenom).localeCompare(String(b.prenom), 'fr'); })
    .map(function (m) { return [m.prenom || '', m.paye ? 'oui' : 'non', Number(m.montant) || 0, m.mode || '', dt_(m.date)]; });
  ecrireVue_(ss, nomOnglet_('Membres', saison),
    ['Prénom', 'Payé', 'Montant (€)', 'Mode de paiement', 'Date'], rows, { 3: EUR, 5: DATE_FR });
}

/* Volants : séances à gauche, mises à disposition et jours sans séance à droite. */
function rebuildVolantsSaison_(ss, saison, etat) {
  var sessions = etat.sessions.filter(function (x) { return saisonDe_(x.date) === saison; });
  var restocks = etat.restocks.filter(function (x) { return saisonDe_(x.date) === saison; });
  var nones = etat.nones.filter(function (x) { return saisonDe_(x.date) === saison; });

  var sh = ecrireVue_(ss, nomOnglet_('Volants', saison),
    ['Date', 'Joueurs', 'Tubes (anciennes saisies)'],
    sessions.map(function (s) { return [dt_(s.date), s.players, s.tubes]; }),
    { 1: DATE_FR });

  sh.getRange(1, 5, 1, 2).setValues([['Date', 'Tubes mis à disposition']])
    .setFontWeight('bold').setBackground(COULEUR_ENTETE);
  if (restocks.length) {
    sh.getRange(2, 5, restocks.length, 2).setValues(restocks.map(function (r) { return [dt_(r.date), r.tubes]; }));
    sh.getRange(2, 5, restocks.length, 1).setNumberFormat(DATE_FR);
  }

  sh.getRange(1, 8, 1, 1).setValues([['Pas de séance']]).setFontWeight('bold').setBackground(COULEUR_ENTETE);
  if (nones.length) {
    sh.getRange(2, 8, nones.length, 1).setValues(nones.map(function (n) { return [dt_(n.date)]; }));
    sh.getRange(2, 8, nones.length, 1).setNumberFormat(DATE_FR);
  }
  sh.autoResizeColumns(1, 8);
}

/* saisonsCibles : saisons à reconstruire (null = toutes). Le Bilan est toujours recalculé. */
function reconstruireTout_(saisonsCibles) {
  var ss = SpreadsheetApp.getActive();
  var etat = etatVolants_();
  var by = donneesCompta_();
  var saisons = saisonsConnues_(etat, by);
  var aFaire = saisons.filter(function (s) { return !saisonsCibles || saisonsCibles.indexOf(s) >= 0 || !ss.getSheetByName(nomOnglet_('Compta', s)); });

  aFaire.forEach(function (s) {
    rebuildComptaSaison_(ss, s, by);
    rebuildMembresSaison_(ss, s, by);
    rebuildVolantsSaison_(ss, s, etat);
  });

  rebuildBilan_(ss, saisons, etat, by);
  nettoyerAnciennesFeuilles_(ss);

  var bilan = ss.getSheetByName('Bilan');
  if (bilan) { bilan.activate(); ss.moveActiveSheet(1); }
  masquerJournaux_();
}

/* Supprime les anciennes feuilles recalculées des versions précédentes. Les Journaux ne sont jamais touchés. */
function nettoyerAnciennesFeuilles_(ss) {
  ss.getSheets().forEach(function (s) {
    var nom = s.getName();
    var ancien = ANCIENNES_FEUILLES.indexOf(nom) >= 0 || PREFIXES_ANCIENS.some(function (p) { return nom.indexOf(p) === 0; });
    if (ancien && ss.getSheets().length > 1) ss.deleteSheet(s);
  });
}

/* ---------- Bilan (global) ---------- */
function rebuildBilan_(ss, saisons, etat, by) {
  var sh = ss.getSheetByName('Bilan') || ss.insertSheet('Bilan');
  var f = sh.getFilter();
  if (f) f.remove();
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 240);
  for (var c = 2; c <= 9; c++) sh.setColumnWidth(c, 130);

  var r = 1;
  sh.getRange(r, 1).setValue('La Plume Beynatoise : bilan').setFontSize(16).setFontWeight('bold').setFontColor(COULEUR_TITRE);
  r++;
  sh.getRange(r, 1).setValue('Mis à jour le ' + Utilities.formatDate(new Date(), 'Europe/Paris', 'dd/MM/yyyy à HH:mm'))
    .setFontColor('#666666');
  r += 2;

  var lignesVolants = saisons.map(function (s) {
    var ses = etat.sessions.filter(function (x) { return saisonDe_(x.date) === s; });
    var rest = etat.restocks.filter(function (x) { return saisonDe_(x.date) === s; });
    var nSeances = ses.length;
    var joueurs = somme_(ses.map(function (x) { return Number(x.players) || 0; }));
    var tubes = somme_(rest.map(function (x) { return Number(x.tubes) || 0; }))
      + somme_(ses.map(function (x) { return Number(x.tubes) || 0; }));
    var cout = tubes * etat.tubePrice;
    return [s, nSeances, joueurs, nSeances ? joueurs / nSeances : 0, tubes, tubes * VOLANTS_PAR_TUBE, cout, joueurs ? cout / joueurs : 0];
  });
  r = titreBloc_(sh, r, 'Volants par saison');
  r = ecrireBloc_(sh, r,
    ['Saison', 'Séances', 'Joueurs', 'Joueurs par séance', 'Tubes', 'Volants', 'Dépense volants (€)', 'Coût par joueur et séance (€)'],
    lignesVolants, [null, '0', '0', '0.0', '0', '0', EUR, EUR]);

  var bilanCompta = bilanParSaison_(by);
  var lignesCompta = saisons.map(function (s) {
    var b = bilanCompta.filter(function (x) { return x.saison === s; })[0] || { recettes: 0, depenses: 0, attente: 0 };
    return [s, b.recettes, b.depenses, b.recettes - b.depenses, b.attente];
  });
  r = titreBloc_(sh, r, 'Comptabilité par saison');
  r = ecrireBloc_(sh, r, ['Saison', 'Recettes (€)', 'Dépenses (€)', 'Solde (€)', 'Chèques en attente (€)'], lignesCompta, [null, EUR, EUR, EUR, EUR]);

  var formatsSaisons = [null];
  saisons.forEach(function () { formatsSaisons.push(EUR); });

  r = titreBloc_(sh, r, 'Recettes par catégorie');
  r = ecrireBloc_(sh, r, ['Catégorie'].concat(saisons),
    categoriesBilan_(by, CATEGORIES_RECETTES, true).map(function (cat) {
      return [cat].concat(saisons.map(function (s) { return sommeCategorie_(by, cat, s, true); }));
    }), formatsSaisons);

  r = titreBloc_(sh, r, 'Dépenses par catégorie');
  r = ecrireBloc_(sh, r, ['Catégorie'].concat(saisons),
    categoriesBilan_(by, CATEGORIES_DEPENSES, false).map(function (cat) {
      return [cat].concat(saisons.map(function (s) { return sommeCategorie_(by, cat, s, false); }));
    }), formatsSaisons);

  sh.activate();
}

/* ---------- Copie de sécurité quotidienne ----------
 * Activée automatiquement par installer(). Une copie datée du Sheet est rangée chaque nuit dans le dossier
 * « Sauvegardes volants » (les 30 plus récentes sont gardées).
 */
function copieDeSecurite() {
  var file = DriveApp.getFileById(SpreadsheetApp.getActive().getId());
  var it = DriveApp.getFoldersByName(NOM_DOSSIER_COPIES);
  var dossier = it.hasNext() ? it.next() : DriveApp.createFolder(NOM_DOSSIER_COPIES);
  var stamp = Utilities.formatDate(new Date(), 'Europe/Paris', 'yyyy-MM-dd');
  var nom = 'Volants – copie ' + stamp;
  var deja = dossier.getFilesByName(nom);
  if (deja.hasNext()) return; // une seule copie par jour
  file.makeCopy(nom, dossier);
  var copies = [], fi = dossier.getFiles();
  while (fi.hasNext()) copies.push(fi.next());
  copies.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  copies.slice(NB_COPIES_GARDEES).forEach(function (f) { f.setTrashed(true); });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function byDate_(a, b) { return String(a.date).localeCompare(String(b.date)); }

function dt_(iso) {
  var p = String(iso || '').split('-');
  return p.length === 3 ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])) : '';
}
