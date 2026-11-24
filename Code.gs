/**
 * Sauvegarde de l'appli La Plume Beynatoise : volants + compta
 *
 * Ce script reçoit les modifications envoyées par l'appli et les range dans ce Google Sheet :
 *  - « Journal »  : toutes les modifications, en ajout seul (rien n'est jamais effacé ni modifié). C'est la vraie sauvegarde.
 *  - « Séances »  : le tableau lisible (une ligne par séance) + les statistiques, recalculé à chaque envoi.
 *  - « Réglages » : prix du tube, volants par tube, séances par an.
 *
 * ⚠️ Changez le CODE_SECRET ci-dessous, puis saisissez le même dans l'appli (Sauvegarde et sécurité).
 */
var CODE_SECRET = 'CHANGEZ-MOI';
var NOM_DOSSIER_COPIES = 'Sauvegardes volants';
var NB_COPIES_GARDEES = 30;
var VOLANTS_PAR_TUBE = 12;
var SEANCES_PAR_AN = 96; // 2 séances par semaine × 52 semaines, moins 8 séances qui n'ont pas lieu

var COLS_JOURNAL = ['id', 'ts', 'type', 'sid', 'date', 'joueurs', 'tubes', 'supprimee', 'prixTube', 'stockAvant', 'achetes'];

var KINDS_COMPTA = ['op', 'cheque', 'espece', 'comptage', 'membre'];
var COLS_COMPTA = ['id', 'ts', 'kind', 'key', 'data', 'supprime'];

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var body = JSON.parse(e.postData.contents);
    if (body.token !== CODE_SECRET) return json_({ ok: false, error: 'token' });
    var events = body.events || [];
    var ids = [];
    var volantsEv = [], comptaEv = [];
    events.forEach(function (ev) {
      if (!ev || typeof ev.id !== 'string') return;
      ids.push(ev.id); // accusé de réception
      if (KINDS_COMPTA.indexOf(ev.kind) >= 0) comptaEv.push(ev); else volantsEv.push(ev);
    });
    var added = 0;
    if (volantsEv.length) added += appendVolants_(volantsEv);
    if (comptaEv.length) added += appendCompta_(comptaEv);
    SpreadsheetApp.flush();
    if (volantsEv.length) rebuild_();
    if (comptaEv.length) rebuildCompta_();
    return json_({ ok: true, ids: ids, added: added });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
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
  if (!e || !e.parameter || e.parameter.token !== CODE_SECRET) return json_({ ok: false, error: 'token' });
  return json_({ ok: true, events: readJournal_(), compta: readComptaJournal_() });
}

/* ---------- Journal ---------- */
function journal_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Journal');
  if (!sh) {
    sh = ss.insertSheet('Journal');
    sh.getRange(1, 1, 1, COLS_JOURNAL.length).setValues([COLS_JOURNAL]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLS_JOURNAL.length).setBackground('#e3f1e8');
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

/* ---------- Tableau lisible, recalculé à partir du journal ---------- */
function rebuild_() {
  var events = readJournal_().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : 1); });
  var bySid = {}, byRid = {}, byNid = {}, settings = { tubePrice: 23.95 };
  events.forEach(function (e) {
    if (e.type === 'session') bySid[e.sid] = e;
    else if (e.type === 'restock') byRid[e.rid] = e;
    else if (e.type === 'noSession') byNid[e.nid] = e;
    else settings = { tubePrice: e.tubePrice == null ? 23.95 : e.tubePrice };
  });
  var sessions = Object.keys(bySid).map(function (k) { return bySid[k]; }).filter(function (e) { return !e.deleted; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var restocks = Object.keys(byRid).map(function (k) { return byRid[k]; }).filter(function (e) { return !e.deleted; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var nones = Object.keys(byNid).map(function (k) { return byNid[k]; }).filter(function (e) { return !e.deleted; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });

  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('Séances') || ss.insertSheet('Séances', 0);
  sh.clear();
  sh.getRange(1, 1, 1, 3).setValues([['Date', 'Joueurs', 'Tubes (anciennes saisies)']]).setFontWeight('bold').setBackground('#e3f1e8');
  if (sessions.length) {
    var vals = sessions.map(function (s) {
      var p = s.date.split('-');
      return [new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])), s.players, s.tubes];
    });
    sh.getRange(2, 1, vals.length, 3).setValues(vals);
    sh.getRange(2, 1, vals.length, 1).setNumberFormat('dd/mm/yyyy');
  }
  // Tubes mis à disposition des joueurs (restocks) : colonnes H et I
  sh.getRange(1, 8, 1, 2).setValues([['Date restock', 'Tubes mis à dispo']]).setFontWeight('bold').setBackground('#e3f1e8');
  if (restocks.length) {
    var rv = restocks.map(function (r) {
      var q = r.date.split('-');
      return [new Date(Number(q[0]), Number(q[1]) - 1, Number(q[2])), r.tubes];
    });
    sh.getRange(2, 8, rv.length, 2).setValues(rv);
    sh.getRange(2, 8, rv.length, 1).setNumberFormat('dd/mm/yyyy');
  }
  // Jours « pas de séance » (vacances, salle fermée…) : colonne K
  sh.getRange(1, 11, 1, 1).setValues([['Pas de séance']]).setFontWeight('bold').setBackground('#e3f1e8');
  if (nones.length) {
    var nv = nones.map(function (r) { var q = r.date.split('-'); return [new Date(Number(q[0]), Number(q[1]) - 1, Number(q[2]))]; });
    sh.getRange(2, 11, nv.length, 1).setValues(nv).setNumberFormat('dd/mm/yyyy');
  }
  var m = Math.max(restocks.length + 1, 2);
  sh.setFrozenRows(1);

  // Réglages
  var rg = ss.getSheetByName('Réglages') || ss.insertSheet('Réglages');
  rg.clear();
  rg.getRange(1, 1, 3, 2).setValues([
    ['Prix du tube (€)', settings.tubePrice], ['Volants par tube', VOLANTS_PAR_TUBE], ['Séances par an (2 par semaine × 52 − 8 sans séance)', SEANCES_PAR_AN]
  ]);
  rg.getRange(1, 1, 3, 1).setFontWeight('bold');
  rg.autoResizeColumns(1, 1);

  // Statistiques (formules : elles restent vivantes si vous ajoutez des lignes à la main)
  var n = Math.max(sessions.length + 1, 2);
  var stats = [
    ['Séances', '=COUNT(B2:B' + n + ')'],
    ['Joueurs au total', '=SUM(B2:B' + n + ')'],
    ['Joueurs par séance', '=IFERROR(F3/F2,0)'],
    ['Tubes mis à disposition', '=SUM(I2:I' + m + ')+SUM(C2:C' + n + ')'],
    ['Volants consommés', "=F5*'Réglages'!B2"],
    ['Volants par séance', '=IFERROR(F6/F2,0)'],
    ['Volant / joueur / séance', '=IFERROR(F6/F3,0)'],
    ['Coût / joueur / séance (€)', "=IFERROR(F5*'Réglages'!B1/F3,0)"],
    ['Dépensé en volants (€)', "=F5*'Réglages'!B1"],
    ['Tubes par séance', '=IFERROR(F5/F2,0)'],
    ['Tubes par an (96 séances)', "=F11*'Réglages'!B3"],
    ['Budget volants par an (€)', "=F12*'Réglages'!B1"]
  ];
  sh.getRange(1, 5, 1, 2).setValues([['Statistiques', '']]).setFontWeight('bold').setBackground('#e3f1e8');
  sh.getRange(2, 5, stats.length, 1).setValues(stats.map(function (r) { return [r[0]]; }));
  sh.getRange(2, 6, stats.length, 1).setFormulas(stats.map(function (r) { return [r[1]]; }));
  sh.getRange(2, 6, stats.length, 1).setNumberFormat('0.00');
  sh.setColumnWidth(5, 210);
  sh.autoResizeColumns(1, 3);
  sh.autoResizeColumns(8, 2);
}

/* ---------- Copie de sécurité quotidienne (optionnelle) ----------
 * Pour l'activer : dans l'éditeur Apps Script, menu « Déclencheurs » (icône horloge) > Ajouter un déclencheur >
 * fonction « copieDeSecurite », source « Selon le temps », « Minuteur quotidien ».
 * Une copie datée du Sheet est rangée dans le dossier « Sauvegardes volants » (les 30 plus récentes sont gardées).
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

/* ==================== COMPTA (même appli, même classeur) ==================== */
/* Journal séparé « JournalCompta » ; vues « Opérations », « Chèques », « Espèces », « Membres ». */
function comptaJournal_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName('JournalCompta');
  if (!sh) {
    sh = ss.insertSheet('JournalCompta');
    sh.getRange(1, 1, 1, COLS_COMPTA.length).setValues([COLS_COMPTA]).setFontWeight('bold').setBackground('#e3f1e8');
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

/* Vues lisibles : dernière version de chaque fiche, supprimées exclues. */
function rebuildCompta_() {
  var events = readComptaJournal_().sort(function (a, b) { return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.id < b.id ? -1 : 1); });
  var latest = {};
  events.forEach(function (e) { latest[e.kind + ':' + e.key] = e; });
  var by = { op: [], cheque: [], espece: [], membre: [] };
  Object.keys(latest).forEach(function (k) {
    var e = latest[k];
    if (e.deleted || !by[e.kind]) return;
    by[e.kind].push(e.data);
  });
  var ss = SpreadsheetApp.getActive();
  writeView_(ss, 'Opérations', ['Date', 'Sens', 'Libellé', 'Catégorie', 'Montant (€)'],
    by.op.sort(byDate_).map(function (o) { return [dt_(o.date), o.sens, o.libelle, o.categorie, o.montant]; }));
  writeView_(ss, 'Chèques', ['Date remise', 'Payeur', 'Montant (€)', 'Statut', 'N°'],
    by.cheque.sort(byDate_).map(function (c) { return [dt_(c.date), c.payeur, c.montant, c.statut, c.numero || '']; }));
  writeView_(ss, 'Espèces', ['Date', 'Sens', 'Libellé', 'Montant (€)'],
    by.espece.sort(byDate_).map(function (x) { return [dt_(x.date), x.sens, x.libelle, x.montant]; }));
  writeView_(ss, 'Membres', ['Prénom', 'Saison', 'Payé', 'Montant (€)', 'Mode', 'Date'],
    by.membre.sort(function (a, b) { return String(a.prenom).localeCompare(String(b.prenom), 'fr'); })
      .map(function (m) { return [m.prenom, m.saison, m.paye ? 'oui' : 'non', m.montant || '', m.mode || '', dt_(m.date)]; }));
}

function writeView_(ss, name, header, rows) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.clear();
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e3f1e8');
  sh.setFrozenRows(1);
  if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
}

function byDate_(a, b) { return String(a.date).localeCompare(String(b.date)); }
function dt_(iso) {
  var p = String(iso || '').split('-');
  return p.length === 3 ? new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])) : '';
}
