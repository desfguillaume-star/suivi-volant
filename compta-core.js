/* Logique pure de la compta (testable avec Node, aucun accès navigateur).
   Journal en ajout seul : une correction ou une suppression est un nouvel événement.
   Saison = du 1er septembre au 31 août (saison 2025/2026 = 01/09/2025 → 31/08/2026).

   Une seule saisie pour tout l'argent : l'opération (recette ou dépense) avec son mode de paiement.
   - Chèque reçu : recette en mode « chèque », comptée seulement une fois encaissée (« pointe »).
   - Espèces : opérations en mode « espèces » ; la caisse se calcule dessus.
   - Cotisation : un membre payé crée automatiquement une recette « Adhésions ».
   Les anciennes fiches « cheque » et « espece » du journal sont relues comme des opérations. */
(function (root) {
  'use strict';
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CATEGORIES_RECETTES = ['Adhésions', 'Subventions', 'Partenariats', 'Animations et tournois', 'Divers recettes'];
  var CATEGORIES_DEPENSES = ['Volants', 'Location de salle', 'Matériel', 'Affiliation et licences', 'Déplacements et tournois', 'Frais bancaires', 'Assurances', 'Divers dépenses'];
  var MODES = ['virement', 'chèque', 'espèces', 'carte'];
  var MODES_ACCEPTES = MODES.concat(['autre']);
  var COTISATION_DEFAUT = 50;
  var DEBUT_COMPTA = '2025-09-01';
  var KINDS = ['op', 'cheque', 'espece', 'comptage', 'membre'];

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
    /* Toutes les saisons depuis le début de la compta, même sans écriture encore. */
    for (var s = saisonOf(DEBUT_COMPTA); s <= cur; s = saisonOf(addDays(saisonBounds(s).fin, 1))) set[s] = true;
    events.forEach(function (e) { if (e.data && DATE_RE.test(e.data.date || '')) set[saisonOf(e.data.date)] = true; });
    return Object.keys(set).sort();
  }

  /* Une recette par chèque n'est comptée qu'une fois encaissée. */
  function enAttente(o) { return o.sens === 'recette' && o.mode === 'chèque' && !o.pointe; }

  /* État courant : dernière version de chaque fiche, supprimées exclues. */
  function computeState(events) {
    var latest = {};
    events.slice().sort(cmpEvents).forEach(function (e) { latest[e.kind + ':' + e.key] = e; });
    var out = { ops: [], comptages: [], membres: [] };
    Object.keys(latest).forEach(function (k) {
      var e = latest[k];
      if (e.deleted) return;
      var rec = Object.assign({ id: e.key }, e.data);
      if (e.kind === 'op') out.ops.push(rec);
      else if (e.kind === 'cheque') {
        if (rec.statut === 'rejete') return;
        out.ops.push({ id: rec.id, legacy: 'cheque', date: rec.date, sens: 'recette', libelle: 'Chèque ' + (rec.payeur || ''), montant: rec.montant, categorie: 'Divers recettes', mode: 'chèque', pointe: rec.statut === 'encaisse' });
      } else if (e.kind === 'espece') {
        var rec2 = rec.sens === 'entree';
        out.ops.push({ id: rec.id, legacy: 'espece', date: rec.date, sens: rec2 ? 'recette' : 'depense', libelle: rec.libelle, montant: rec.montant, categorie: rec2 ? 'Divers recettes' : 'Divers dépenses', mode: 'espèces' });
      }
      else if (e.kind === 'comptage') out.comptages.push(rec);
      else if (e.kind === 'membre') out.membres.push(rec);
    });
    /* Une cotisation payée devient automatiquement une recette « Adhésions » : rien à saisir deux fois. */
    out.membres.forEach(function (m) {
      var montant = Number(m.montant) || 0;
      if (m.paye && montant > 0) {
        out.ops.push({ id: 'm-' + m.id, date: m.date || saisonBounds(m.saison).debut, saison: m.saison, sens: 'recette',
          libelle: 'Cotisation ' + m.prenom, montant: montant, categorie: 'Adhésions', mode: m.mode || 'virement', pointe: true, auto: true });
      }
    });
    var byDate = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id < b.id ? -1 : 1); };
    out.ops.sort(byDate); out.comptages.sort(byDate);
    out.membres.sort(function (a, b) { return a.prenom.localeCompare(b.prenom, 'fr'); });
    return out;
  }

  function inSaison(rec, label) {
    if (rec.saison) return rec.saison === label;
    var b = saisonBounds(label); return rec.date >= b.debut && rec.date <= b.fin;
  }

  /* Totaux d'une saison. Les chèques en attente sont à part, hors recettes. */
  function totals(state, label) {
    var rec = 0, dep = 0, attente = 0;
    state.ops.filter(function (o) { return inSaison(o, label); }).forEach(function (o) {
      if (enAttente(o)) attente += o.montant;
      else if (o.sens === 'recette') rec += o.montant;
      else dep += o.montant;
    });
    return { recettes: round2(rec), depenses: round2(dep), resultat: round2(rec - dep), chequesAttente: round2(attente) };
  }

  /* Solde de caisse espèces à une date (toutes saisons confondues depuis le début) et écart avec le dernier comptage. */
  function caisse(state, atIso) {
    var solde = 0;
    state.ops.forEach(function (o) {
      if (o.mode === 'espèces' && o.date <= atIso && !enAttente(o)) solde += o.sens === 'recette' ? o.montant : -o.montant;
    });
    var dernier = null;
    state.comptages.forEach(function (c) { if (c.date <= atIso && (!dernier || c.date >= dernier.date)) dernier = c; });
    return { solde: round2(solde), comptage: dernier, ecart: dernier ? round2(dernier.montant - solde) : null };
  }

  /* Répartition par catégorie pour une saison : { recettes: {cat: €}, depenses: {cat: €} }. */
  function parCategorie(state, label) {
    var out = { recettes: {}, depenses: {} };
    state.ops.filter(function (o) { return inSaison(o, label) && !enAttente(o); }).forEach(function (o) {
      var m = o.sens === 'recette' ? out.recettes : out.depenses;
      m[o.categorie] = round2((m[o.categorie] || 0) + o.montant);
    });
    return out;
  }

  /* Suivi des membres : nombre de cotisations payées et montant total pour une saison. */
  function membresSaison(state, label) {
    var payes = state.membres.filter(function (m) { return m.saison === label && m.paye; });
    return { total: state.membres.filter(function (m) { return m.saison === label; }).length,
      payes: payes.length, montant: round2(payes.reduce(function (t, m) { return t + (Number(m.montant) || 0); }, 0)) };
  }

  /* Membres de la saison précédente absents de la saison donnée : à reconduire (non payés, cotisation par défaut). */
  function aReconduire(state, label) {
    var prev = saisonOf(addDays(saisonBounds(label).debut, -1));
    var deja = {};
    state.membres.filter(function (m) { return m.saison === label; }).forEach(function (m) { deja[m.prenom.toLowerCase()] = true; });
    return state.membres.filter(function (m) { return m.saison === prev && !deja[m.prenom.toLowerCase()]; }).map(function (m) {
      return { prenom: m.prenom, saison: label, paye: false, mode: m.mode && m.mode !== 'autre' ? m.mode : 'virement', montant: COTISATION_DEFAUT, date: saisonBounds(label).debut };
    });
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  function validMontant(v) { return typeof v === 'number' && isFinite(v) && v > 0 && v <= 100000 && Math.abs(Math.round(v * 100) - v * 100) < 1e-6; }
  function validDate(d, todayIso) {
    return DATE_RE.test(d || '') && !isNaN(Date.parse(d)) && d >= DEBUT_COMPTA && d <= addDays(todayIso, 1);
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }

  function validateOp(d, todayIso) {
    var e = [];
    if (!validDate(d.date, todayIso)) e.push('Date invalide (à partir du 01/09/2025, pas dans le futur).');
    if (!d.libelle || d.libelle.trim().length < 2 || d.libelle.length > 80) e.push('Description : entre 2 et 80 caractères.');
    if (!validMontant(d.montant)) e.push('Montant : nombre positif, 2 décimales maximum.');
    if (['recette', 'depense'].indexOf(d.sens) < 0) e.push('Sens : recette ou dépense.');
    if (!d.categorie || String(d.categorie).length > 40) e.push('Catégorie manquante.');
    if (MODES.indexOf(d.mode) < 0) e.push('Mode de paiement : virement, chèque, espèces ou carte.');
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
    if (!d.prenom || !/^[A-Za-zÀ-ÿ'-]{2,20}( [A-Za-zÀ-ÿ]\.?)?$/.test(d.prenom.trim())) e.push('Un seul prénom (tiret accepté), 2 à 20 lettres, puis au plus l\'initiale du nom (ex. Marie B.) : pas de nom de famille.');
    if (!/^\d{4}\/\d{4}$/.test(d.saison || '')) e.push('Saison invalide.');
    if (d.paye && !validMontant(Number(d.montant))) e.push('Montant payé : nombre positif.');
    if (d.mode && MODES_ACCEPTES.indexOf(d.mode) < 0) e.push('Mode de paiement inconnu.');
    return { errors: e, warnings: [] };
  }

  /* Fusion sans doublon des événements reçus (import, Sheet). */
  function mergeEvents(local, incoming) {
    var have = {}; local.forEach(function (e) { have[e.id] = true; });
    var added = [];
    incoming.forEach(function (e) {
      if (!e || typeof e.id !== 'string' || typeof e.ts !== 'string' || typeof e.key !== 'string') return;
      if (KINDS.indexOf(e.kind) < 0) return;
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
    lines.push('Chèques en attente (non comptés);' + fr(t.chequesAttente));
    var cats = parCategorie(state, label);
    [['Recettes par catégorie', cats.recettes], ['Dépenses par catégorie', cats.depenses]].forEach(function (b) {
      lines.push('');
      lines.push(b[0]);
      Object.keys(b[1]).sort().forEach(function (c) { lines.push(c + ';' + fr(b[1][c])); });
    });
    lines.push('');
    lines.push('Opérations');
    lines.push('Date;Sens;Description;Catégorie;Mode;Montant;Encaissé');
    state.ops.filter(function (o) { return inSaison(o, label); }).forEach(function (o) {
      lines.push([o.date, o.sens, o.libelle, o.categorie, o.mode || '', fr(o.montant), enAttente(o) ? 'en attente' : ''].join(';'));
    });
    return lines.join('\n');
  }
  function fr(n) { return String(round2(n)).replace('.', ','); }

  root.ComptaCore = {
    CATEGORIES_RECETTES: CATEGORIES_RECETTES, CATEGORIES_DEPENSES: CATEGORIES_DEPENSES, MODES: MODES,
    COTISATION_DEFAUT: COTISATION_DEFAUT, DEBUT_COMPTA: DEBUT_COMPTA,
    cmpEvents: cmpEvents, saisonOf: saisonOf, saisonBounds: saisonBounds, saisonsFrom: saisonsFrom,
    computeState: computeState, totals: totals, caisse: caisse, parCategorie: parCategorie, membresSaison: membresSaison,
    aReconduire: aReconduire, enAttente: enAttente, inSaison: inSaison,
    validateOp: validateOp, validateComptage: validateComptage, validateMembre: validateMembre,
    mergeEvents: mergeEvents, recapCsv: recapCsv, addDays: addDays
  };
})(typeof window !== 'undefined' ? window : module.exports);
