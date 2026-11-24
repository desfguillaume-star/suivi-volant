/* Logique pure de la compta (testable avec Node, aucun accès navigateur).
   Journal en ajout seul : une correction ou une suppression est un nouvel événement.
   Saison = du 1er septembre au 31 août (saison 2025/2026 = 01/09/2025 → 31/08/2026). */
(function (root) {
  'use strict';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CATEGORIES = ['Volants', 'Salle', 'Assurance', 'Fédération', 'Frais bancaires', 'Subvention', 'Cotisations', 'Matériel', 'Autre'];
  var STATUTS_CHEQUE = ['attente', 'encaisse', 'rejete'];
  var MODES = ['chèque', 'virement', 'espèces', 'autre'];
  var DEBUT_COMPTA = '2025-09-01';

  function cmpEvents(a, b) { if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1; return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  /* Saison d'une date : "2025/2026" */
  function saisonOf(iso) {
    var y = Number(iso.slice(0, 4)), m = Number(iso.slice(5, 7));
    var start = m >= 9 ? y : y - 1;
    return start + '/' + (start + 1);
  }
  function saisonBounds(label) {
    var y = Number(label.slice(0, 4));
    return { debut: y + '-09-01', fin: (y + 1) + '-08-31' };
  }
  function saisonsFrom(events, todayIso) {
    var set = {}, cur = saisonOf(todayIso);
    set[cur] = true;
    events.forEach(function (e) { if (e.data && DATE_RE.test(e.data.date || '')) set[saisonOf(e.data.date)] = true; });
    return Object.keys(set).sort();
  }

  /* État courant : dernière version de chaque fiche, supprimées exclues. */
  function computeState(events) {
    var latest = {};
    events.slice().sort(cmpEvents).forEach(function (e) {
      var k = e.kind + ':' + e.key;
      latest[k] = e;
    });
    var out = { ops: [], cheques: [], especes: [], comptages: [], membres: [] };
    Object.keys(latest).forEach(function (k) {
      var e = latest[k];
      if (e.deleted) return;
      var rec = Object.assign({ id: e.key }, e.data);
      if (e.kind === 'op') out.ops.push(rec);
      else if (e.kind === 'cheque') out.cheques.push(rec);
      else if (e.kind === 'espece') out.especes.push(rec);
      else if (e.kind === 'comptage') out.comptages.push(rec);
      else if (e.kind === 'membre') out.membres.push(rec);
    });
    var byDate = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); };
    out.ops.sort(byDate); out.cheques.sort(byDate); out.especes.sort(byDate); out.comptages.sort(byDate);
    out.membres.sort(function (a, b) { return a.prenom.localeCompare(b.prenom, 'fr'); });
    return out;
  }

  function inSaison(rec, label) { var b = saisonBounds(label); return rec.date >= b.debut && rec.date <= b.fin; }

  /* Totaux d'une saison. Chèques : comptés en recette seulement une fois encaissés.
     Espèces : entrées et sorties. Membres : suivi seulement, pas de total. */
  function totals(state, label) {
    var rec = 0, dep = 0, chequesAttente = 0, chequesRejetes = 0, espEntrees = 0, espSorties = 0;
    state.ops.filter(function (o) { return inSaison(o, label); }).forEach(function (o) {
      if (o.sens === 'recette') rec += o.montant; else dep += o.montant;
    });
    state.cheques.filter(function (c) { return inSaison(c, label); }).forEach(function (c) {
      if (c.statut === 'encaisse') rec += c.montant;
      else if (c.statut === 'attente') chequesAttente += c.montant;
      else if (c.statut === 'rejete') chequesRejetes += c.montant;
    });
    state.especes.filter(function (x) { return inSaison(x, label); }).forEach(function (x) {
      if (x.sens === 'entree') { rec += x.montant; espEntrees += x.montant; } else { dep += x.montant; espSorties += x.montant; }
    });
    return {
      recettes: round2(rec), depenses: round2(dep), resultat: round2(rec - dep),
      chequesAttente: round2(chequesAttente), chequesRejetes: round2(chequesRejetes),
      espEntrees: round2(espEntrees), espSorties: round2(espSorties)
    };
  }

  /* Solde de caisse espèces à une date (toutes saisons confondues depuis le début) et écart avec le dernier comptage. */
  function caisse(state, atIso) {
    var solde = 0;
    state.especes.forEach(function (x) { if (x.date <= atIso) solde += x.sens === 'entree' ? x.montant : -x.montant; });
    var dernier = null;
    state.comptages.forEach(function (c) { if (c.date <= atIso && (!dernier || c.date >= dernier.date)) dernier = c; });
    return { solde: round2(solde), comptage: dernier, ecart: dernier ? round2(dernier.montant - solde) : null };
  }

  /* Répartition des dépenses par catégorie pour une saison. */
  function parCategorie(state, label) {
    var m = {};
    state.ops.filter(function (o) { return inSaison(o, label) && o.sens === 'depense'; }).forEach(function (o) {
      m[o.categorie] = round2((m[o.categorie] || 0) + o.montant);
    });
    return m;
  }

  /* Suivi des membres : nombre de cotisations payées et montant total pour une saison. */
  function membresSaison(state, label) {
    var payes = state.membres.filter(function (m) { return m.saison === label && m.paye; });
    return { total: state.membres.filter(function (m) { return m.saison === label; }).length,
      payes: payes.length, montant: round2(payes.reduce(function (t, m) { return t + (Number(m.montant) || 0); }, 0)) };
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function validMontant(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= 100000 && Math.round(v * 100) === v * 100; }
  function validDate(d, todayIso) {
    return DATE_RE.test(d || '') && !isNaN(Date.parse(d)) && d >= DEBUT_COMPTA && d <= addDays(todayIso, 1);
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

  function validateOp(d, todayIso) {
    var e = [];
    if (!validDate(d.date, todayIso)) e.push('Date invalide (à partir du 01/09/2025, pas dans le futur).');
    if (!d.libelle || d.libelle.trim().length < 2 || d.libelle.length > 80) e.push('Libellé : entre 2 et 80 caractères.');
    if (!validMontant(d.montant)) e.push('Montant : nombre positif, 2 décimales maximum.');
    if (['recette', 'depense'].indexOf(d.sens) < 0) e.push('Sens : recette ou dépense.');
    if (CATEGORIES.indexOf(d.categorie) < 0) e.push('Catégorie inconnue.');
    return { errors: e, warnings: [] };
  }
  function validateCheque(d, todayIso) {
    var e = [], w = [];
    if (!validDate(d.date, todayIso)) e.push('Date de remise invalide.');
    if (!d.payeur || !/^[A-Za-zÀ-ÿ'-]{2,20}$/.test(d.payeur.trim())) e.push('Payeur : un seul prénom (prénom composé avec tiret accepté), 2 à 20 lettres.');
    if (!validMontant(d.montant)) e.push('Montant : nombre positif, 2 décimales maximum.');
    if (STATUTS_CHEQUE.indexOf(d.statut) < 0) e.push('Statut inconnu.');
    if (d.numero && !/^\d{1,12}$/.test(d.numero)) e.push('Numéro de chèque : chiffres uniquement.');
    return { errors: e, warnings: w };
  }
  function validateEspece(d, todayIso) {
    var e = [];
    if (!validDate(d.date, todayIso)) e.push('Date invalide.');
    if (['entree', 'sortie'].indexOf(d.sens) < 0) e.push('Sens : entrée ou sortie.');
    if (!validMontant(d.montant)) e.push('Montant : nombre positif, 2 décimales maximum.');
    if (!d.libelle || d.libelle.trim().length < 2) e.push('Libellé obligatoire.');
    return { errors: e, warnings: [] };
  }
  function validateComptage(d, todayIso) {
    var e = [];
    if (!validDate(d.date, todayIso)) e.push('Date invalide.');
    if (typeof d.montant !== 'number' || !isFinite(d.montant) || d.montant < 0 || d.montant > 100000) e.push('Montant compté invalide.');
    return { errors: e, warnings: [] };
  }
  function validateMembre(d) {
    var e = [];
    if (!d.prenom || !/^[A-Za-zÀ-ÿ'-]{2,20}$/.test(d.prenom.trim())) e.push('Un seul prénom (prénom composé avec tiret accepté), 2 à 20 lettres : pas de nom de famille.');
    if (!/^\d{4}\/\d{4}$/.test(d.saison || '')) e.push('Saison invalide.');
    if (d.paye && !validMontant(Number(d.montant))) e.push('Montant payé : nombre positif.');
    if (d.mode && MODES.indexOf(d.mode) < 0) e.push('Mode de paiement inconnu.');
    return { errors: e, warnings: [] };
  }

  /* Fusion sans doublon des événements reçus (import, Sheet). */
  function mergeEvents(local, incoming) {
    var have = {}; local.forEach(function (e) { have[e.id] = true; });
    var added = [];
    incoming.forEach(function (e) {
      if (!e || typeof e.id !== 'string' || typeof e.ts !== 'string' || typeof e.key !== 'string') return;
      if (['op', 'cheque', 'espece', 'comptage', 'membre'].indexOf(e.kind) < 0) return;
      if (!e.data || typeof e.data !== 'object' || (!DATE_RE.test(e.data.date || '') && !e.data.prenom)) return;
      if (have[e.id]) return;
      have[e.id] = true; added.push(e);
    });
    return added;
  }

  /* Récap annuel en CSV (séparateur ;), pour l'AG. */
  function recapCsv(state, label) {
    var t = totals(state, label), lines = [];
    lines.push('Récapitulatif saison ' + label);
    lines.push('Recettes;' + fr(t.recettes));
    lines.push('Dépenses;' + fr(t.depenses));
    lines.push('Résultat;' + fr(t.resultat));
    lines.push('Chèques en attente;' + fr(t.chequesAttente));
    lines.push('Chèques rejetés;' + fr(t.chequesRejetes));
    lines.push('');
    lines.push('Dépenses par catégorie');
    var cats = parCategorie(state, label);
    Object.keys(cats).sort().forEach(function (c) { lines.push(c + ';' + fr(cats[c])); });
    lines.push('');
    lines.push('Opérations');
    lines.push('Date;Sens;Libellé;Catégorie;Montant');
    state.ops.filter(function (o) { return inSaison(o, label); }).forEach(function (o) {
      lines.push([o.date, o.sens, o.libelle, o.categorie, fr(o.montant)].join(';'));
    });
    return lines.join('\n');
  }
  function fr(n) { return String(round2(n)).replace('.', ','); }

  root.ComptaCore = {
    CATEGORIES: CATEGORIES, STATUTS_CHEQUE: STATUTS_CHEQUE, MODES: MODES, DEBUT_COMPTA: DEBUT_COMPTA,
    cmpEvents: cmpEvents, saisonOf: saisonOf, saisonBounds: saisonBounds, saisonsFrom: saisonsFrom,
    computeState: computeState, totals: totals, caisse: caisse, parCategorie: parCategorie, membresSaison: membresSaison,
    validateOp: validateOp, validateCheque: validateCheque, validateEspece: validateEspece,
    validateComptage: validateComptage, validateMembre: validateMembre,
    mergeEvents: mergeEvents, recapCsv: recapCsv, addDays: addDays
  };
})(typeof window !== 'undefined' ? window : module.exports);
