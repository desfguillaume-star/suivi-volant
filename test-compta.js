/* Test : l'appli (compta-core.js) et le script du Sheet (Code.gs) doivent donner les mêmes totaux.
   Lancer : node test-compta.js */
'use strict';
var fs = require('fs'), vm = require('vm'), assert = require('assert');
var K = require('./compta-core.js').ComptaCore;
var ctx = { Logger: { log: function () {} }, console: console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(__dirname + '/Code.gs', 'utf8'), ctx);

var n = 0;
function ev(kind, key, data, deleted, ts) { n++; return { id: 'e' + n, ts: ts || ('2026-11-' + String(10 + n).padStart(2, '0') + 'T10:00:00Z'), kind: kind, key: key, data: data, deleted: !!deleted }; }
var events = [
  ev('op', 'a', { date: '2026-10-05', sens: 'depense', libelle: 'Tubes', montant: 95.8, categorie: 'Volants', mode: 'virement', pointe: true }),
  ev('op', 'b', { date: '2026-10-12', sens: 'recette', libelle: 'Subvention', montant: 300, categorie: 'Subventions', mode: 'chèque', pointe: false }),
  ev('op', 'c', { date: '2026-10-20', sens: 'recette', libelle: 'Tournoi', montant: 40, categorie: 'Animations et tournois', mode: 'espèces', pointe: true }),
  ev('op', 'd', { date: '2026-10-22', sens: 'depense', libelle: 'Café', montant: 12.5, categorie: 'Divers dépenses', mode: 'espèces', pointe: true }),
  ev('op', 'x', { date: '2026-10-23', sens: 'depense', libelle: 'Erreur', montant: 999, categorie: 'Matériel', mode: 'carte', pointe: true }),
  ev('op', 'x', { date: '2026-10-23', sens: 'depense', libelle: 'Erreur', montant: 999, categorie: 'Matériel', mode: 'carte', pointe: true }, true),
  ev('membre', 'm1', { prenom: 'Marie', saison: '2026/2027', paye: true, mode: 'chèque', montant: 50, date: '2026-09-10' }),
  ev('membre', 'm2', { prenom: 'Paul', saison: '2026/2027', paye: false, mode: 'virement', montant: 50, date: '2026-09-10' }),
  // anciennes fiches
  ev('cheque', 'c1', { date: '2026-09-15', payeur: 'Luc', montant: 50, statut: 'encaisse' }),
  ev('cheque', 'c2', { date: '2026-09-16', payeur: 'Eva', montant: 50, statut: 'attente' }),
  ev('cheque', 'c3', { date: '2026-09-17', payeur: 'Tom', montant: 50, statut: 'rejete' }),
  ev('espece', 'e1', { date: '2026-09-18', sens: 'entree', montant: 20, libelle: 'Don' }),
  ev('espece', 'e2', { date: '2026-09-19', sens: 'sortie', montant: 5, libelle: 'Eau' }),
  // saison précédente
  ev('op', 'old', { date: '2026-03-01', sens: 'depense', libelle: 'Salle', montant: 100, categorie: 'Salle', mode: 'virement', pointe: true })
];

var st = K.computeState(events);
var by = ctx.donneesDepuis_(events);
var bilan = ctx.bilanParSaison_(by);

['2025/2026', '2026/2027'].forEach(function (s) {
  var t = K.totals(st, s), b = bilan.filter(function (x) { return x.saison === s; })[0] || { recettes: 0, depenses: 0, attente: 0 };
  assert.strictEqual(Math.round(b.recettes * 100) / 100, t.recettes, 'recettes ' + s);
  assert.strictEqual(Math.round(b.depenses * 100) / 100, t.depenses, 'dépenses ' + s);
  assert.strictEqual(Math.round(b.attente * 100) / 100, t.chequesAttente, 'attente ' + s);
  var cats = K.parCategorie(st, s);
  Object.keys(cats.recettes).forEach(function (c) { assert.strictEqual(Math.round(ctx.sommeCategorie_(by, c, s, true) * 100) / 100, cats.recettes[c], 'cat recette ' + c); });
  Object.keys(cats.depenses).forEach(function (c) { assert.strictEqual(Math.round(ctx.sommeCategorie_(by, c, s, false) * 100) / 100, cats.depenses[c], 'cat dépense ' + c); });
});

// valeurs attendues (calcul à la main)
var t = K.totals(st, '2026/2027');
assert.strictEqual(t.recettes, 40 + 50 + 50 + 20, 'recettes : tournoi + cotisation Marie + chèque Luc + don');      // 160
assert.strictEqual(t.depenses, 95.8 + 12.5 + 5, 'dépenses');                                                       // 113.3
assert.strictEqual(t.chequesAttente, 300 + 50, 'chèques en attente (subvention + Eva)');                           // 350
assert.strictEqual(K.totals(st, '2025/2026').depenses, 100);
// caisse espèces : +40 −12.5 +20 −5 = 42.5
assert.strictEqual(K.caisse(st, '2026-12-31').solde, 42.5, 'caisse');
// la cotisation de Paul (non payée) ne crée rien ; reconduction depuis la saison précédente
assert.strictEqual(st.membres.length, 2);
assert.strictEqual(K.aReconduire(st, '2027/2028').length, 2);
assert.strictEqual(K.aReconduire(st, '2026/2027').length, 0);
// saison d'un événement (reconstruction ciblée du Sheet)
assert.strictEqual(ctx.saisonEvenement_(events[0]), '2026/2027');
assert.strictEqual(ctx.saisonEvenement_(events[6]), '2026/2027');
assert.strictEqual(ctx.saisonEvenement_({ id: 'v', type: 'session', date: '2027-01-12' }), '2026/2027');
// validations
assert.strictEqual(K.validateOp({ date: '2026-10-05', sens: 'depense', libelle: 'ok', montant: 5, categorie: 'Volants', mode: 'virement' }, '2026-11-24').errors.length, 0);
assert.ok(K.validateOp({ date: '2026-10-05', sens: 'depense', libelle: 'ok', montant: 5, categorie: 'Volants', mode: 'bitcoin' }, '2026-11-24').errors.length > 0);
// CSV
assert.ok(K.recapCsv(st, '2026/2027').indexOf('Adhésions;50') >= 0, 'csv adhésions');

// fenêtre des jours sans séance (core.js)
var C = require('./core.js').Core;
var m = C.missingSessionDates([{ date: '2025-10-06' }], [], '2026-11-24');
assert.ok(m.length <= 12 && m.every(function (d) { return d >= '2026-10-13'; }), 'jours manquants limités aux 6 dernières semaines');
assert.strictEqual(C.saisonOf('2026-08-31'), '2025/2026');
assert.strictEqual(C.saisonOf('2026-09-01'), '2026/2027');
console.log('Tous les tests passent.');
