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
    var st = state(), s = currentSeason(), bornes = K.saisonBounds(s), t = K.totals(st, s), c = K.caisse(st, bornes.fin < today() ? bornes.fin : today());
    var mem = K.membresSaison(st, s);
    $('cptSeason').innerHTML = seasonsList().map(function (x) { return '<option value="' + x + '"' + (x === s ? ' selected' : '') + '>' + x + '</option>'; }).join('');
    function k(v, l) { return '<div class="kpi"><b>' + v + '</b><span>' + l + '</span></div>'; }
    $('cptKpis').innerHTML =
      k(eur(t.recettes), 'recettes') + k(eur(t.depenses), 'dépenses') + k(eur(t.resultat), 'résultat') + k(eur(t.chequesAttente), 'chèques en attente') +
      k(eur(c.solde), 'caisse espèces (calculée)') + k(c.comptage ? eur(c.comptage.montant) : '–', 'caisse comptée') +
      k(c.ecart == null ? '–' : eur(c.ecart), 'écart de caisse') + k(mem.payes + ' / ' + mem.total, 'membres à jour');

    function bloc(titre, obj) {
      var cles = Object.keys(obj).sort();
      return '<div class="sub" style="margin:8px 0 2px"><b>' + titre + '</b></div>' + (cles.length ? cles.map(function (x) { return '<div class="hist"><span>' + esc(x) + '</span><b>' + eur(obj[x]) + '</b></div>'; }).join('') : '<div class="empty">Rien cette saison.</div>');
    }
    var cats = K.parCategorie(st, s);
    $('cptCats').innerHTML = bloc('Recettes', cats.recettes) + bloc('Dépenses', cats.depenses);

    var ops = st.ops.filter(function (o) { return K.inSaison(o, s); }).reverse();
    $('cptOpsN').textContent = '(' + ops.length + ')';
    $('cptOps').innerHTML = ops.length ? ops.map(function (o) {
      var att = K.enAttente(o), plus = o.sens === 'recette';
      var tags = '<span class="sub">' + esc(o.categorie) + ' · ' + esc(o.mode || '') + '</span>' + (att ? ' <span class="tag warn">chèque en attente</span>' : '');
      var btns = o.auto ? '<span class="sub">Cotisation : à modifier dans « Membres »</span>' :
        (att ? '<button class="small primary" data-cact="encaisse" data-id="' + esc(o.id) + '">Encaissé</button>' : '') +
        '<button class="small" data-cact="edit-op" data-id="' + esc(o.id) + '">Modifier</button>' +
        '<button class="small" data-cact="del-op" data-id="' + esc(o.id) + '">' + (pendingDel === 'op:' + o.id ? 'Confirmer' : 'Supprimer') + '</button>';
      return '<div class="item cpt"><div class="d">' + fmtDate(o.date) + '</div><div><b>' + esc(o.libelle) + '</b><div>' + tags + '</div></div>' +
        '<div class="amt ' + o.sens + '">' + (plus ? '+' : '−') + eur(o.montant) + '</div>' +
        '<div class="acts" style="grid-column:1/-1">' + btns + '</div></div>';
    }).join('') : '<div class="empty">Aucune opération.</div>';

    var mm = st.membres.filter(function (m) { return m.saison === s; });
    var rec = K.aReconduire(st, s);
    $('cptReconduire').hidden = !rec.length;
    $('cptReconduire').textContent = 'Reconduire ' + rec.length + ' membre' + (rec.length > 1 ? 's' : '') + ' de la saison précédente';
    $('cptMembres').innerHTML = mm.length ? mm.map(function (m) {
      var conf = pendingDel === 'mb:' + m.id;
      return '<div class="mb"><div class="mb-top"><div class="n">' + esc(m.prenom) + '</div>' +
        '<div class="r"><span class="tag' + (m.paye ? '' : ' warn') + '">' + (m.paye ? 'à jour' : 'non payé') + '</span>' +
        (m.paye ? '<span class="sub">' + eur(m.montant) + ' · ' + esc(m.mode || '') + '</span>' : '') + '</div></div>' +
        '<div class="acts">' +
        '<button class="small" data-cact="toggle-membre" data-id="' + esc(m.id) + '">' + (m.paye ? 'Non payé' : 'Payé') + '</button>' +
        '<button class="small" data-cact="rename-membre" data-id="' + esc(m.id) + '">Renommer</button>' +
        '<button class="small' + (conf ? ' danger' : '') + '" data-cact="del-membre" data-id="' + esc(m.id) + '">' + (conf ? 'Confirmer ?' : 'Supprimer') + '</button></div></div>';
    }).join('') : '<div class="empty">Aucun membre pour cette saison.</div>';

    renderSync();
  }

  /* ---------- formulaires ---------- */
  var sensOp = 'depense', editingOp = null;

  function fillForms() {
    $('cOpDate').value = today(); $('cCmDate').value = today();
    $('cOpMode').innerHTML = K.MODES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    $('cMbMode').innerHTML = K.MODES.map(function (c) { return '<option>' + c + '</option>'; }).join('');
    $('cMbMontant').value = K.COTISATION_DEFAUT;
    fillCats(sensOp);
  }
  function fillCats(sens, choisie) {
    var list = (sens === 'recette' ? K.CATEGORIES_RECETTES : K.CATEGORIES_DEPENSES).slice();
    if (choisie && list.indexOf(choisie) < 0) list.push(choisie);   // ancienne catégorie conservée à la modification
    $('cOpCat').innerHTML = list.map(function (c) { return '<option' + (c === choisie ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }
  function showErr(id, list) { var m = $(id); m.innerHTML = list.map(esc).join('<br>'); m.hidden = !list.length; }
  function num(id) { var v = String($(id).value).replace(',', '.'); return v === '' ? NaN : Number(v); }
  function handleSubmit(form, fn) { form.addEventListener('submit', function (e) { e.preventDefault(); fn(); }); }

  /* Données enregistrées d'une opération (sans les champs calculés). */
  function dataOp(o) {
    return { date: o.date, sens: o.sens, libelle: o.libelle, montant: o.montant, categorie: o.categorie, mode: o.mode, pointe: !!o.pointe };
  }
  /* Écrit une opération modifiée. Une ancienne fiche « chèque » ou « espèces » est remplacée par une opération. */
  function ecrireOp(o, data) {
    var key = o.id;
    if (o.legacy) { record(o.legacy, o.id, { date: o.date }, true); key = newId(); }
    record('op', key, data);
  }
  function resetOpForm() {
    editingOp = null;
    $('cOpLib').value = ''; $('cOpMontant').value = ''; $('cOpDate').value = today();
    $('cOpSave').textContent = 'Enregistrer'; $('cOpCancel').hidden = true;
    fillCats(sensOp);
  }
  function startEditOp(o) {
    editingOp = o.id;
    switchTab('op'); setSens(o.sens, o.categorie);
    $('cOpDate').value = o.date; $('cOpLib').value = o.libelle; $('cOpMontant').value = o.montant; $('cOpMode').value = o.mode || 'virement';
    $('cOpSave').textContent = 'Enregistrer la modification'; $('cOpCancel').hidden = false;
    showErr('cOpErr', []);
    $('fOp').scrollIntoView({ block: 'center' });
  }

  /* ---------- montage ---------- */
  function mountMarkup() {
    root.innerHTML =
      '<div class="cpt-head"><div><h1 style="font-size:20px;margin:0">💶 Compta</h1><div class="sub">Accès réservé à la trésorerie</div></div>' +
      '<div style="display:flex;gap:8px;align-items:center"><select id="cptSeason" class="sel" aria-label="Saison"></select><button id="cptSync" class="badge" type="button">…</button></div></div>' +
      '<div class="card"><h2>Bilan de la saison</h2><div class="kpis" id="cptKpis"></div>' +
      '<div class="btns"><button class="small" id="cptCount" type="button">Compter la caisse</button><button class="small" id="cptCsv" type="button">Exporter le récap (CSV, pour l\'AG)</button></div></div>' +
      '<div class="card"><h2>Ajouter</h2>' +
      '<div class="tabbar2" role="tablist">' +
      '<button class="seg on" data-ctab="op" type="button">Recette / dépense</button>' +
      '<button class="seg" data-ctab="mb" type="button">Membre</button></div>' +
      '<form id="fOp" data-cform="op"><div class="seg2"><button type="button" class="seg2b on" data-sens="depense">Dépense</button><button type="button" class="seg2b" data-sens="recette">Recette</button></div>' +
      '<label>Date</label><input id="cOpDate" type="date"><label>Description</label><input id="cOpLib" maxlength="80" placeholder="ex. 4 tubes Badmania, subvention mairie">' +
      '<label>Montant (€)</label><input id="cOpMontant" type="number" inputmode="decimal" step="0.01" min="0" placeholder="0,00">' +
      '<label>Catégorie</label><select id="cOpCat"></select><label>Mode de paiement</label><select id="cOpMode"></select>' +
      '<div class="hint">Un chèque reçu reste « en attente » (hors recettes) jusqu\'au bouton « Encaissé ».</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px"><button class="primary" id="cOpSave" type="submit" style="flex:1">Enregistrer</button><button type="button" id="cOpCancel" hidden>Annuler</button></div><div id="cOpErr" class="msg" hidden></div></form>' +
      '<form id="fCm" data-cform="cm" hidden><label>Date du comptage</label><input id="cCmDate" type="date"><label>Montant compté dans la caisse (€)</label><input id="cCmMontant" type="number" inputmode="decimal" step="0.01" min="0">' +
      '<button class="primary" type="submit">Enregistrer le comptage</button><div id="cCmErr" class="msg" hidden></div></form>' +
      '<form id="fMb" data-cform="mb" hidden><label>Prénom (un seul) + initiale du nom si besoin</label><input id="cMbPrenom" maxlength="24" placeholder="ex. Marie B.">' +
      '<label>Saison</label><select id="cMbSaison"></select><label>Mode de paiement</label><select id="cMbMode"></select>' +
      '<label>Montant payé (€)</label><input id="cMbMontant" type="number" inputmode="decimal" step="0.01" min="0"><label><input id="cMbPaye" type="checkbox" checked style="width:auto;min-height:0"> Cotisation payée</label>' +
      '<button class="primary" type="submit">Ajouter le membre</button><div id="cMbErr" class="msg" hidden></div></form></div>' +
      '<details class="card"><summary>Opérations de la saison <span class="count" id="cptOpsN"></span></summary><div id="cptOps" style="margin-top:8px"></div></details>' +
      '<details class="card" open><summary>Membres</summary><div class="note">Prénoms (avec l&#39;initiale du nom si besoin). Une cotisation payée est comptée automatiquement en recette « Adhésions » : ne la saisissez pas une seconde fois.</div>' +
      '<div class="btns"><button class="small" id="cptReconduire" type="button" hidden></button></div><div id="cptMembres" style="margin-top:8px"></div></details>' +
      '<details class="card"><summary>Totaux par catégorie</summary><div id="cptCats" style="margin-top:8px"></div></details>' +
      '<div class="card"><h2>Sauvegarde</h2><div class="note">La compta utilise la même connexion que les volants (menu « Sauvegarde et sécurité »). <span id="cptNote"></span></div>' +
      '<div class="btns"><button class="small" id="cptExport" type="button">Exporter (JSON)</button><button class="small" id="cptImport" type="button">Importer…</button></div>' +
      '<input id="cptFile" type="file" accept=".json,application/json" hidden><div id="cptImportMsg" class="note" role="status"></div></div>' +
      '<div id="cptToast" class="toast"></div>';
  }

  function bind() {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('button,[data-ctab]'); if (!b) return;
      if (b.hasAttribute('data-ctab')) { switchTab(b.getAttribute('data-ctab')); return; }
      if (b.hasAttribute('data-sens')) { setSens(b.getAttribute('data-sens')); return; }
      var act = b.getAttribute('data-cact'), id = b.getAttribute('data-id');
      var o = (act === 'del-op' || act === 'edit-op' || act === 'encaisse') ? state().ops.filter(function (x) { return x.id === id; })[0] : null;
      if (act === 'del-op' && o) {
        if (pendingDel !== 'op:' + id) { pendingDel = 'op:' + id; render(); setTimeout(function () { if (pendingDel === 'op:' + id) { pendingDel = null; render(); } }, 4000); return; }
        pendingDel = null; record(o.legacy || 'op', id, o.legacy ? { date: o.date } : dataOp(o), true); toast('Opération supprimée');
      } else if (act === 'edit-op' && o) {
        startEditOp(o);
      } else if (act === 'encaisse' && o) {
        var d = dataOp(o); d.pointe = true; ecrireOp(o, d); toast('Chèque encaissé');
      } else if (act === 'rename-membre' || act === 'del-membre') {
        var mb = state().membres.filter(function (x) { return x.id === id; })[0];
        if (!mb) return;
        var base = { prenom: mb.prenom, saison: mb.saison, paye: mb.paye, mode: mb.mode || 'virement', montant: mb.montant, date: mb.date };
        if (act === 'rename-membre') {
          var np = window.prompt('Prénom (avec l\'initiale du nom si besoin, ex. Marie B.)', mb.prenom);
          if (np == null) return;
          base.prenom = np.trim();
          var vr = K.validateMembre(base); if (vr.errors.length) { toast(vr.errors[0]); return; }
          record('membre', id, base); toast('Membre renommé');
        } else {
          if (pendingDel !== 'mb:' + id) { pendingDel = 'mb:' + id; render(); setTimeout(function () { if (pendingDel === 'mb:' + id) { pendingDel = null; render(); } }, 4000); return; }
          pendingDel = null; record('membre', id, base, true); toast('Membre supprimé');
        }
      } else if (act === 'toggle-membre') {
        var m = state().membres.filter(function (x) { return x.id === id; })[0];
        if (m) {
          var n = { prenom: m.prenom, saison: m.saison, paye: !m.paye, mode: m.mode || 'virement', montant: m.montant, date: m.date };
          if (n.paye) { n.montant = Number(m.montant) > 0 ? m.montant : K.COTISATION_DEFAUT; n.date = today(); }
          record('membre', id, n); toast(n.paye ? 'Marqué payé' : 'Marqué non payé');
        }
      }
    });
    root.addEventListener('change', function (e) { if (e.target.id === 'cptSeason') { season = e.target.value; render(); } });

    handleSubmit($('fOp'), function () {
      var existant = editingOp ? state().ops.filter(function (x) { return x.id === editingOp; })[0] : null;
      var d = { date: $('cOpDate').value, libelle: $('cOpLib').value.trim(), montant: Math.round(num('cOpMontant') * 100) / 100, sens: sensOp, categorie: $('cOpCat').value, mode: $('cOpMode').value };
      d.pointe = (d.sens === 'recette' && d.mode === 'chèque') ? !!(existant && existant.pointe && existant.mode === 'chèque') : true;
      var v = K.validateOp(d, today()); if (v.errors.length) return showErr('cOpErr', v.errors);
      showErr('cOpErr', []);
      if (existant) ecrireOp(existant, d); else record('op', newId(), d);
      toast(existant ? 'Opération modifiée' : (d.pointe ? 'Opération enregistrée' : 'Chèque enregistré (en attente)'));
      resetOpForm();
    });
    $('cOpCancel').addEventListener('click', resetOpForm);
    handleSubmit($('fCm'), function () {
      var d = { date: $('cCmDate').value, montant: Math.round(num('cCmMontant') * 100) / 100 };
      var v = K.validateComptage(d, today()); if (v.errors.length) return showErr('cCmErr', v.errors);
      showErr('cCmErr', []); record('comptage', newId(), d); $('cCmMontant').value = ''; switchTab('op'); toast('Comptage enregistré');
    });
    handleSubmit($('fMb'), function () {
      var paye = $('cMbPaye').checked, d = { prenom: $('cMbPrenom').value.trim(), saison: $('cMbSaison').value, paye: paye, mode: $('cMbMode').value, montant: Math.round(num('cMbMontant') * 100) / 100, date: today() };
      if (!paye) d.montant = Number(d.montant) > 0 ? d.montant : K.COTISATION_DEFAUT;
      var v = K.validateMembre(d); if (v.errors.length) return showErr('cMbErr', v.errors);
      showErr('cMbErr', []); record('membre', newId(), d); $('cMbPrenom').value = ''; $('cMbMontant').value = K.COTISATION_DEFAUT; toast('Membre ajouté');
    });
    $('cptReconduire').addEventListener('click', function () {
      var list = K.aReconduire(state(), currentSeason());
      list.forEach(function (d) { record('membre', newId(), d); });
      toast(list.length + ' membre(s) reconduit(s), à marquer payés au fil de l\'eau');
    });
    $('cptCount').addEventListener('click', function () { switchTab('cm'); $('fCm').scrollIntoView({ block: 'center' }); });

    $('cptSync').addEventListener('click', function () { sync().then(function (r) { toast(r.ok ? 'Sauvegarde à jour' : 'Échec : ' + r.reason); }); });
    $('cptExport').addEventListener('click', function () {
      var blob = new Blob([JSON.stringify({ app: 'compta', version: 1, exportedAt: new Date().toISOString(), events: events.map(function (e) { return { id: e.id, ts: e.ts, kind: e.kind, key: e.key, data: e.data, deleted: e.deleted }; }) }, null, 1)], { type: 'application/json' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'compta-' + today() + '.json'; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    });
    $('cptImport').addEventListener('click', function () { $('cptFile').click(); });
    $('cptFile').addEventListener('change', function () {
      var f = this.files && this.files[0]; if (!f) return;
      var msg = $('cptImportMsg'), rd = new FileReader();
      rd.onload = function () {
        try {
          var j = JSON.parse(rd.result), list = Array.isArray(j) ? j : j.events;
          if (!Array.isArray(list)) throw new Error('format');
          var added = K.mergeEvents(events, list);
          if (!added.length) { msg.textContent = 'Fichier lu : rien de nouveau à importer.'; return; }
          added.forEach(function (e) { e.synced = false; events.push(e); });
          mirrorSave(); render();
          idbPut(added).then(function () { msg.textContent = added.length + ' élément(s) importé(s).'; scheduleSync(500); });
        } catch (err) { msg.textContent = 'Fichier non reconnu : rien n\'a été modifié.'; }
      };
      rd.readAsText(f); this.value = '';
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
    ['op', 'cm', 'mb'].forEach(function (x) { var f = root.querySelector('[data-cform="' + x + '"]'); if (f) f.hidden = x !== t; });
  }
  function setSens(s, categorie) {
    sensOp = s;
    document.querySelectorAll('[data-sens]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sens') === s); });
    fillCats(s, categorie);
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
    switchTab('op'); setSens('depense');
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
