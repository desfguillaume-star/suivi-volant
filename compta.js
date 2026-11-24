(function () {
  'use strict';
  var K = window.ComptaCore;
  var $ = function (id) { return document.getElementById(id); };
  var root = null, db = null, events = [], cfg = { url: '', token: '' }, syncing = false, syncTimer = null;
  var season = null, tab = 'op', pendingDel = null;

  /* ---------- utilitaires ---------- */
  function today() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
  function eur(n) { return (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
  function fmtDate(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function newId() { return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function toast(t) { var el = $('cptToast'); el.textContent = t; el.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(function () { el.classList.remove('on'); }, 2200); }

  /* ---------- stockage séparé de celui des volants ---------- */
  function idbOpen() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('compta', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('events', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); }; r.onerror = r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function idbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      try { var q = db.transaction('events', 'readonly').objectStore('events').getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { res([]); }; }
      catch (e) { res([]); }
    });
  }
  function idbPut(list) {
    return new Promise(function (res) {
      if (!db || !list.length) return res(!db ? false : true);
      try {
        var tx = db.transaction('events', 'readwrite'), st = tx.objectStore('events');
        list.forEach(function (e) { st.put(e); });
        tx.oncomplete = function () { res(true); }; tx.onerror = tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  }
  function mirrorSave() { try { localStorage.setItem('compta-mirror', JSON.stringify(events)); } catch (e) {} }
  function mirrorLoad() { try { return JSON.parse(localStorage.getItem('compta-mirror') || '[]'); } catch (e) { return []; } }
  /* Une seule configuration pour toute l'appli : celle des volants (adresse + code secret). */
  function cfgLoad() { try { var c = JSON.parse(localStorage.getItem('volants-cfg') || '{}'); cfg.url = c.url || ''; cfg.token = c.token || ''; } catch (e) {} }

  function record(kind, key, data, deleted) {
    var ev = { id: newId(), ts: new Date().toISOString(), kind: kind, key: key, data: data, deleted: !!deleted, synced: false };
    events.push(ev); mirrorSave();
    idbPut([ev]).then(function (ok) { if (!ok) toast('Stockage de secours uniquement'); });
    render(); scheduleSync(1500);
    return ev;
  }

  /* ---------- synchro avec le Sheet de la compta ---------- */
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(sync, ms); }
  function sync() {
    cfgLoad();
    if (!cfg.url || !cfg.token || syncing) return Promise.resolve({ ok: false, reason: 'config' });
    syncing = true; renderSync();
    var pend = events.filter(function (e) { return !e.synced; });
    var body = JSON.stringify({ token: cfg.token, events: pend.map(function (e) { return { id: e.id, ts: e.ts, kind: e.kind, key: e.key, data: e.data, deleted: e.deleted }; }) });
    return fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.error === 'token' ? 'Code d\'accès incorrect.' : 'Réponse inattendue.');
        var ok = {}; (r.ids || []).forEach(function (id) { ok[id] = true; });
        var changed = [];
        events.forEach(function (e) { if (!e.synced && ok[e.id]) { e.synced = true; changed.push(e); } });
        mirrorSave(); return idbPut(changed);
      })
      .then(function () { return { ok: true }; })
      .catch(function (err) { return { ok: false, reason: String((err && err.message) || err) }; })
      .then(function (res) { syncing = false; renderSync(); return res; });
  }
  function renderSync() {
    var pend = events.filter(function (e) { return !e.synced; }).length, b = $('cptSync');
    if (!cfg.url || !cfg.token) { b.textContent = '⚠ Sauvegarde compta à configurer'; b.className = 'badge warn'; }
    else if (syncing) { b.textContent = '⏳ Synchronisation…'; b.className = 'badge'; }
    else if (pend) { b.textContent = '⏳ ' + pend + ' non envoyé(s)'; b.className = 'badge warn'; }
    else { b.textContent = '✓ Sauvegardé'; b.className = 'badge'; }
  }

  /* ---------- données dérivées ---------- */
  function state() { return K.computeState(events); }
  function seasonsList() { return K.saisonsFrom(events, today()); }
  function currentSeason() { return season || K.saisonOf(today()); }

  /* ---------- rendu ---------- */
  function render() {
    if (!root) return;
    var st = state(), s = currentSeason(), t = K.totals(st, s), c = K.caisse(st, K.saisonBounds(s).fin < today() ? K.saisonBounds(s).fin : today());
    var mem = K.membresSaison(st, s);
    $('cptSeason').innerHTML = seasonsList().map(function (x) { return '<option value="' + x + '"' + (x === s ? ' selected' : '') + '>' + x + '</option>'; }).join('');
    function k(v, l) { return '<div class="kpi"><b>' + v + '</b><span>' + l + '</span></div>'; }
    $('cptKpis').innerHTML =
      k(eur(t.recettes), 'recettes') + k(eur(t.depenses), 'dépenses') + k(eur(t.resultat), 'résultat') + k(eur(t.chequesAttente), 'chèques en attente') +
      k(eur(c.solde), 'caisse espèces (calculée)') + k(c.comptage ? eur(c.comptage.montant) : '–', 'caisse comptée') +
      k(c.ecart == null ? '–' : eur(c.ecart), 'écart de caisse') + k(mem.payes + ' / ' + mem.total, 'membres à jour');

    var cats = K.parCategorie(st, s);
    $('cptCats').innerHTML = Object.keys(cats).length ? Object.keys(cats).sort().map(function (x) { return '<div class="hist"><span>' + esc(x) + '</span><b>' + eur(cats[x]) + '</b></div>'; }).join('') : '<div class="empty">Aucune dépense cette saison.</div>';

    var ops = st.ops.filter(function (o) { return o.date >= K.saisonBounds(s).debut && o.date <= K.saisonBounds(s).fin; }).reverse();
    $('cptOps').innerHTML = ops.length ? ops.map(function (o) {
      return '<div class="item cpt"><div class="d">' + fmtDate(o.date) + '</div><div><b>' + esc(o.libelle) + '</b><div class="sub">' + esc(o.categorie) + '</div></div>' +
        '<div class="amt ' + o.sens + '">' + (o.sens === 'recette' ? '+' : '−') + eur(o.montant) + '</div>' +
        '<div class="acts" style="grid-column:1/-1"><button class="small" data-cact="del-op" data-id="' + esc(o.id) + '">' + (pendingDel === 'op:' + o.id ? 'Confirmer' : 'Supprimer') + '</button></div></div>';
    }).join('') : '<div class="empty">Aucune opération.</div>';

    var ch = st.cheques.filter(function (c2) { return c2.date >= K.saisonBounds(s).debut && c2.date <= K.saisonBounds(s).fin; }).reverse();
    $('cptCheques').innerHTML = ch.length ? ch.map(function (c2) {
      var sel = K.STATUTS_CHEQUE.map(function (x) { return '<option value="' + x + '"' + (x === c2.statut ? ' selected' : '') + '>' + x + '</option>'; }).join('');
      return '<div class="item cpt"><div class="d">' + fmtDate(c2.date) + '</div><div><b>' + esc(c2.payeur) + '</b>' + (c2.numero ? ' <span class="sub">n° ' + esc(c2.numero) + '</span>' : '') + '<div class="sub">' + eur(c2.montant) + '</div></div>' +
        '<div class="acts"><select data-cact="statut" data-id="' + esc(c2.id) + '">' + sel + '</select></div></div>';
    }).join('') : '<div class="empty">Aucun chèque cette saison.</div>';

    var ex = st.especes.filter(function (x) { return x.date >= K.saisonBounds(s).debut && x.date <= K.saisonBounds(s).fin; }).reverse();
    $('cptEspeces').innerHTML = ex.length ? ex.map(function (x) {
      return '<div class="item cpt"><div class="d">' + fmtDate(x.date) + '</div><div><b>' + esc(x.libelle) + '</b><div class="sub">' + (x.sens === 'entree' ? 'entrée' : 'sortie') + '</div></div>' +
        '<div class="amt ' + (x.sens === 'entree' ? 'recette' : 'depense') + '">' + (x.sens === 'entree' ? '+' : '−') + eur(x.montant) + '</div></div>';
    }).join('') : '<div class="empty">Aucun mouvement d\'espèces.</div>';

    var mm = st.membres.filter(function (m) { return m.saison === s; });
    $('cptMembres').innerHTML = mm.length ? mm.map(function (m) {
      return '<div class="item cpt"><div class="d" style="font-size:15px">' + esc(m.prenom) + '</div><div><span class="tag' + (m.paye ? '' : ' warn') + '">' + (m.paye ? 'à jour' : 'non payé') + '</span>' +
        (m.paye ? ' <span class="sub">' + eur(m.montant) + ' · ' + esc(m.mode || '') + '</span>' : '') + '</div>' +
        '<div class="acts"><button class="small" data-cact="toggle-membre" data-id="' + esc(m.id) + '">' + (m.paye ? 'Marquer non payé' : 'Marquer payé') + '</button></div></div>';
    }).join('') : '<div class="empty">Aucun membre pour cette saison.</div>';

    renderSync();
  }

  /* ---------- formulaires ---------- */
  function fillForms() {
    $('cOpDate').value = today(); $('cChDate').value = today(); $('cEsDate').value = today(); $('cCmDate').value = today();
    $('cOpCat').innerHTML = K.CATEGORIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    $('cChStatut').innerHTML = K.STATUTS_CHEQUE.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    $('cMbMode').innerHTML = K.MODES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
  }
  function showErr(id, list) { var m = $(id); m.innerHTML = list.map(esc).join('<br>'); m.hidden = !list.length; }
  function num(id) { var v = String($(id).value).replace(',', '.'); return v === '' ? NaN : Number(v); }

  function handleSubmit(form, fn) {
    form.addEventListener('submit', function (e) { e.preventDefault(); fn(); });
  }

  /* ---------- montage ---------- */
  function mountMarkup() {
    root.innerHTML =
      '<div class="cpt-head"><div><h1 style="font-size:20px;margin:0">💶 Compta</h1><div class="sub">Accès réservé à la trésorerie</div></div>' +
      '<div style="display:flex;gap:8px;align-items:center"><select id="cptSeason" class="sel" aria-label="Saison"></select><button id="cptSync" class="badge" type="button">…</button></div></div>' +
      '<div class="card"><h2>Bilan de la saison</h2><div class="kpis" id="cptKpis"></div>' +
      '<div class="btns"><button class="small" id="cptCsv" type="button">Exporter le récap (CSV, pour l\'AG)</button></div></div>' +
      '<div class="card"><h2>Ajouter</h2>' +
      '<div class="tabbar2" role="tablist">' +
      '<button class="seg on" data-ctab="op" type="button">Recette / dépense</button>' +
      '<button class="seg" data-ctab="ch" type="button">Chèque reçu</button>' +
      '<button class="seg" data-ctab="es" type="button">Espèces</button>' +
      '<button class="seg" data-ctab="cm" type="button">Comptage caisse</button>' +
      '<button class="seg" data-ctab="mb" type="button">Membre</button></div>' +
      '<form id="fOp" data-cform="op"><div class="seg2"><button type="button" class="seg2b on" data-sens="depense">Dépense</button><button type="button" class="seg2b" data-sens="recette">Recette</button></div>' +
      '<label>Date</label><input id="cOpDate" type="date"><label>Libellé</label><input id="cOpLib" maxlength="80" placeholder="ex. Badmania, subvention mairie">' +
      '<label>Montant (€)</label><input id="cOpMontant" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0,00">' +
      '<label>Catégorie</label><select id="cOpCat"></select><button class="primary" type="submit">Enregistrer</button><div id="cOpErr" class="msg" hidden></div></form>' +
      '<form id="fCh" data-cform="ch" hidden><label>Date de remise</label><input id="cChDate" type="date"><label>Payeur (prénom)</label><input id="cChPayeur" maxlength="20" placeholder="ex. Marie">' +
      '<label>Montant (€)</label><input id="cChMontant" type="number" inputmode="decimal" step="0.01" min="0"><label>Statut</label><select id="cChStatut"></select>' +
      '<label>N° du chèque (facultatif)</label><input id="cChNum" inputmode="numeric" maxlength="12"><button class="primary" type="submit">Enregistrer le chèque</button><div id="cChErr" class="msg" hidden></div></form>' +
      '<form id="fEs" data-cform="es" hidden><div class="seg2"><button type="button" class="seg2b on" data-esens="sortie">Sortie</button><button type="button" class="seg2b" data-esens="entree">Entrée</button></div>' +
      '<label>Date</label><input id="cEsDate" type="date"><label>Libellé</label><input id="cEsLib" maxlength="80" placeholder="ex. cotisation en liquide, café">' +
      '<label>Montant (€)</label><input id="cEsMontant" type="number" inputmode="decimal" step="0.01" min="0"><button class="primary" type="submit">Enregistrer</button><div id="cEsErr" class="msg" hidden></div></form>' +
      '<form id="fCm" data-cform="cm" hidden><label>Date du comptage</label><input id="cCmDate" type="date"><label>Montant compté dans la caisse (€)</label><input id="cCmMontant" type="number" inputmode="decimal" step="0.01" min="0">' +
      '<button class="primary" type="submit">Enregistrer le comptage</button><div id="cCmErr" class="msg" hidden></div></form>' +
      '<form id="fMb" data-cform="mb" hidden><label>Prénom (un seul, sans nom de famille)</label><input id="cMbPrenom" maxlength="20" placeholder="ex. Marie">' +
      '<label>Saison</label><select id="cMbSaison"></select><label>Mode de paiement</label><select id="cMbMode"></select>' +
      '<label>Montant payé (€)</label><input id="cMbMontant" type="number" inputmode="decimal" step="0.01" min="0"><label><input id="cMbPaye" type="checkbox" checked style="width:auto;min-height:0"> Cotisation payée</label>' +
      '<button class="primary" type="submit">Ajouter le membre</button><div id="cMbErr" class="msg" hidden></div></form></div>' +
      '<details class="card"><summary>Opérations de la saison <span class="count" id="cptOpsN"></span></summary><div id="cptOps" style="margin-top:8px"></div></details>' +
      '<details class="card"><summary>Chèques reçus</summary><div id="cptCheques" style="margin-top:8px"></div></details>' +
      '<details class="card"><summary>Espèces</summary><div id="cptEspeces" style="margin-top:8px"></div></details>' +
      '<details class="card" open><summary>Membres</summary><div class="note">Prénoms uniquement. Le suivi ne compte pas dans les recettes : la cotisation est déjà comptée à sa rentrée (chèque, virement ou espèces).</div><div id="cptMembres" style="margin-top:8px"></div></details>' +
      '<details class="card"><summary>Catégories de dépenses</summary><div id="cptCats" style="margin-top:8px"></div></details>' +
      '<div class="card"><h2>Sauvegarde</h2><div class="note">La compta utilise la même adresse et le même code secret que les volants (menu « Sauvegarde et sécurité »). <span id="cptNote"></span></div>' +
      '<div class="btns"><button class="small" id="cptExport" type="button">Exporter (JSON)</button></div></div>' +
      '<div id="cptToast" class="toast"></div>';
  }

  function bind() {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button,[data-ctab]'); if (!b) return;
      if (b.hasAttribute('data-ctab')) { switchTab(b.getAttribute('data-ctab')); return; }
      if (b.hasAttribute('data-sens')) { setSens(b.getAttribute('data-sens')); return; }
      if (b.hasAttribute('data-esens')) { setEsSens(b.getAttribute('data-esens')); return; }
      var act = b.getAttribute('data-cact'), id = b.getAttribute('data-id');
      if (act === 'del-op') {
        if (pendingDel !== 'op:' + id) { pendingDel = 'op:' + id; render(); setTimeout(function () { if (pendingDel === 'op:' + id) { pendingDel = null; render(); } }, 4000); return; }
        pendingDel = null; var o = state().ops.filter(function (x) { return x.id === id; })[0];
        if (o) { record('op', id, o, true); toast('Opération supprimée'); }
      } else if (act === 'toggle-membre') {
        var m = state().membres.filter(function (x) { return x.id === id; })[0];
        if (m) { var n = Object.assign({}, m, { paye: !m.paye }); record('membre', id, n); toast(n.paye ? 'Marqué payé' : 'Marqué non payé'); }
      }
    });
    root.addEventListener('change', function (e) {
      var t = e.target;
      if (t.getAttribute && t.getAttribute('data-cact') === 'statut') {
        var id = t.getAttribute('data-id'), c = state().cheques.filter(function (x) { return x.id === id; })[0];
        if (c) { record('cheque', id, Object.assign({}, c, { statut: t.value })); toast('Chèque : ' + t.value); }
      }
      if (t.id === 'cptSeason') { season = t.value; render(); }
    });

    var fOp = $('fOp'), sensOp = 'depense';
    window.__cptSens = function (s) { sensOp = s; };
    handleSubmit(fOp, function () {
      var d = { date: $('cOpDate').value, libelle: $('cOpLib').value.trim(), montant: Math.round(num('cOpMontant') * 100) / 100, sens: sensOp, categorie: $('cOpCat').value };
      var v = K.validateOp(d, today()); if (v.errors.length) return showErr('cOpErr', v.errors);
      showErr('cOpErr', []); record('op', newId(), d); $('cOpLib').value = ''; $('cOpMontant').value = ''; toast('Opération enregistrée');
    });
    handleSubmit($('fCh'), function () {
      var d = { date: $('cChDate').value, payeur: $('cChPayeur').value.trim(), montant: Math.round(num('cChMontant') * 100) / 100, statut: $('cChStatut').value, numero: $('cChNum').value.trim() };
      var v = K.validateCheque(d, today()); if (v.errors.length) return showErr('cChErr', v.errors);
      showErr('cChErr', []); record('cheque', newId(), d); $('cChPayeur').value = ''; $('cChMontant').value = ''; $('cChNum').value = ''; toast('Chèque enregistré');
    });
    var esSens = 'sortie';
    window.__cptEsSens = function (s) { esSens = s; };
    handleSubmit($('fEs'), function () {
      var d = { date: $('cEsDate').value, sens: esSens, montant: Math.round(num('cEsMontant') * 100) / 100, libelle: $('cEsLib').value.trim() };
      var v = K.validateEspece(d, today()); if (v.errors.length) return showErr('cEsErr', v.errors);
      showErr('cEsErr', []); record('espece', newId(), d); $('cEsLib').value = ''; $('cEsMontant').value = ''; toast('Mouvement enregistré');
    });
    handleSubmit($('fCm'), function () {
      var d = { date: $('cCmDate').value, montant: Math.round(num('cCmMontant') * 100) / 100 };
      var v = K.validateComptage(d, today()); if (v.errors.length) return showErr('cCmErr', v.errors);
      showErr('cCmErr', []); record('comptage', newId(), d); $('cCmMontant').value = ''; toast('Comptage enregistré');
    });
    handleSubmit($('fMb'), function () {
      var paye = $('cMbPaye').checked, d = { prenom: $('cMbPrenom').value.trim(), saison: $('cMbSaison').value, paye: paye, mode: $('cMbMode').value, montant: paye ? Math.round(num('cMbMontant') * 100) / 100 : 0, date: today() };
      var v = K.validateMembre(d); if (v.errors.length) return showErr('cMbErr', v.errors);
      showErr('cMbErr', []); record('membre', newId(), d); $('cMbPrenom').value = ''; $('cMbMontant').value = ''; toast('Membre ajouté');
    });

    $('cptSync').addEventListener('click', function () { sync().then(function (r) { toast(r.ok ? 'Sauvegarde à jour' : 'Échec : ' + r.reason); }); });
    $('cptExport').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify({ app: 'compta', version: 1, exportedAt: new Date().toISOString(), events: events.map(function (e) { return { id: e.id, ts: e.ts, kind: e.kind, key: e.key, data: e.data, deleted: e.deleted }; }) }, null, 1)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'compta-' + today() + '.json'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    $('cptCsv').addEventListener('click', function () {
      var blob = new Blob(['﻿' + K.recapCsv(state(), currentSeason())], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'recap-' + currentSeason().replace('/', '-') + '.csv'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
  }

  function fillSaisons() {
    var s = currentSeason(), list = seasonsList();
    if (list.indexOf(s) < 0) list.push(s);
    $('cMbSaison').innerHTML = list.map(function (x) { return '<option' + (x === s ? ' selected' : '') + '>' + x + '</option>'; }).join('');
  }
  function switchTab(t) {
    tab = t;
    if (t === 'mb') fillSaisons();
    document.querySelectorAll('[data-ctab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-ctab') === t); });
    ['op', 'ch', 'es', 'cm', 'mb'].forEach(function (x) { var f = root.querySelector('[data-cform="' + x + '"]'); if (f) f.hidden = x !== t; });
  }
  function setSens(s) {
    window.__cptSens(s);
    document.querySelectorAll('[data-sens]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sens') === s); });
  }
  function setEsSens(s) {
    window.__cptEsSens(s);
    document.querySelectorAll('[data-esens]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-esens') === s); });
  }

  /* ---------- démarrage ---------- */
  window.Compta = {
    open: function () { if (root) { root.hidden = false; render(); } },
    close: function () { if (root) root.hidden = true; }
  };

  function init() {
    root = $('tabCompta'); if (!root) return;
    mountMarkup(); fillForms(); bind();
    cfgLoad();
    switchTab('op'); setSens('depense'); setEsSens('sortie');
    idbOpen().then(function (d) { db = d; return idbAll(); }).then(function (fromIdb) {
      events = fromIdb.slice();
      K.mergeEvents(events, mirrorLoad()).forEach(function (e) { events.push(e); });
      events.forEach(function (e) { if (e.synced === undefined) e.synced = false; });
      mirrorSave(); render();
      if (cfg.url && cfg.token) scheduleSync(800);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
