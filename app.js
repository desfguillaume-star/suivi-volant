(function () {
  'use strict';
  var C = window.Core;
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Données initiales (reprises du Google Sheet « SUIVI CONSOMMATION VOLANT ») ---------- */
  var SEED_TS = '2026-11-23T15:00:00.000Z';
  var SEED = [   // séances : [id, date, joueurs]
    ['20261002', '2026-10-02', 10], ['20261005', '2026-10-05', 11], ['20261009', '2026-10-09', 12],
    ['20261012', '2026-10-12', 20], ['20261021', '2026-10-21', 18], ['20261023', '2026-10-23', 12],
    ['20261027', '2026-10-27', 11], ['20261030', '2026-10-30', 12], ['20261102', '2026-11-02', 13],
    ['20261113a', '2026-11-13', 17], ['20261113b', '2026-11-13', 16], ['20261116', '2026-11-16', 13],
    ['20261120', '2026-11-20', 14]
  ];
  var SEED_RESTOCKS = [   // tubes mis à disposition : [id, date, tubes] (colonne « Nbre de tubes mis à dispo » du Sheet)
    ['20261002', '2026-10-02', 4], ['20261027', '2026-10-27', 4], ['20261113', '2026-11-13', 1]
  ];

  var events = [];          // journal complet (ajout seul)
  var db = null;            // IndexedDB (peut rester null : le miroir localStorage prend le relais)
  var cfg = { url: '', token: '', lastSyncOk: null };
  var editingId = null, pendingDelete = null, warnAcked = false, syncing = false, syncTimer = null, persisted = null;

  /* ---------- Utilitaires ---------- */
  function today() { var d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); }
  function fmtDate(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : iso; }
  function fmtDateTime(ts) { try { return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ts; } }
  function fr(n, dec) { return (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('fr-FR', { minimumFractionDigits: dec || 0, maximumFractionDigits: dec || 0 }); }
  function eur(n) { return (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }); }
  function eur2(n) { return (n == null || isNaN(n)) ? '–' : Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function newId() { return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7); }
  function strip(e) { var o = {}; Object.keys(e).forEach(function (k) { if (k !== 'synced') o[k] = e[k]; }); return o; }

  var toastTimer = null;
  function toast(text, actionLabel, action) {
    $('toastText').textContent = text;
    var b = $('toastBtn');
    if (actionLabel) { b.hidden = false; b.textContent = actionLabel; b.onclick = function () { $('toast').classList.remove('on'); action(); }; }
    else { b.hidden = true; b.onclick = null; }
    $('toast').classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $('toast').classList.remove('on'); }, actionLabel ? 7000 : 2500);
  }

  /* ---------- Stockage local : IndexedDB + miroir localStorage (double sécurité) ---------- */
  function idbOpen() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('volants', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('events', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { res(null); };
        r.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function idbAll() {
    return new Promise(function (res) {
      if (!db) return res([]);
      try {
        var q = db.transaction('events', 'readonly').objectStore('events').getAll();
        q.onsuccess = function () { res(q.result || []); };
        q.onerror = function () { res([]); };
      } catch (e) { res([]); }
    });
  }
  function idbPut(list) {
    return new Promise(function (res) {
      if (!db) return res(false);
      try {
        var tx = db.transaction('events', 'readwrite'), st = tx.objectStore('events');
        list.forEach(function (e) { st.put(e); });
        tx.oncomplete = function () { res(true); };
        tx.onerror = function () { res(false); };
        tx.onabort = function () { res(false); };
      } catch (e) { res(false); }
    });
  }
  function mirrorSave() { try { localStorage.setItem('volants-mirror', JSON.stringify(events)); } catch (e) {} }
  function mirrorLoad() { try { return JSON.parse(localStorage.getItem('volants-mirror') || '[]'); } catch (e) { return []; } }
  function cfgSave() { try { localStorage.setItem('volants-cfg', JSON.stringify(cfg)); } catch (e) {} }
  function cfgLoad() { try { var c = JSON.parse(localStorage.getItem('volants-cfg') || '{}'); cfg.url = c.url || ''; cfg.token = c.token || ''; cfg.lastSyncOk = c.lastSyncOk || null; } catch (e) {} }

  /* Ajoute des événements : mémoire + miroir tout de suite, puis IndexedDB. Retourne true si l'écriture durable a réussi. */
  function addEvents(list, alreadySynced) {
    list.forEach(function (e) { e.synced = !!alreadySynced; events.push(e); });
    mirrorSave();
    var p = idbPut(list);
    render();
    if (!alreadySynced) scheduleSync(1200);
    return p;
  }

  /* ---------- Synchronisation vers le Google Sheet ---------- */
  function pendingEvents() { return events.filter(function (e) { return !e.synced; }); }

  function scheduleSync(delay) { clearTimeout(syncTimer); syncTimer = setTimeout(function () { sync(); }, delay); }

  function sync() {
    if (!cfg.url || !cfg.token) { renderBadge(); return Promise.resolve({ ok: false, reason: 'config' }); }
    if (syncing) return Promise.resolve({ ok: false, reason: 'busy' });
    syncing = true; renderBadge();
    var pend = pendingEvents();
    var body = JSON.stringify({ token: cfg.token, events: pend.map(strip) });
    return fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: body, redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.error === 'token' ? 'Code secret incorrect.' : ((r && r.error) || 'Réponse inattendue du script.'));
        var ok = {}; (r.ids || []).forEach(function (id) { ok[id] = true; });
        var changed = [];
        events.forEach(function (e) { if (!e.synced && ok[e.id]) { e.synced = true; changed.push(e); } });
        mirrorSave(); return idbPut(changed);
      })
      .then(function () { cfg.lastSyncOk = Date.now(); cfgSave(); return { ok: true }; })
      .catch(function (err) { return { ok: false, reason: String((err && err.message) || err) }; })
      .then(function (res) { syncing = false; render(); return res; });
  }

  function restoreFromSheet() {
    if (!cfg.url || !cfg.token) { $('backupMsg').textContent = 'Renseignez d\'abord l\'adresse et le code secret.'; return; }
    $('backupMsg').textContent = 'Lecture du Sheet…';
    fetch(cfg.url + (cfg.url.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(cfg.token), { redirect: 'follow' })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) throw new Error(r && r.error === 'token' ? 'Code secret incorrect.' : 'Réponse inattendue du script.');
        var added = C.mergeEvents(events, r.events || []);
        added.forEach(function (e) { e.synced = true; });
        if (added.length) return addEvents(added, true).then(function () { return added.length; });
        return 0;
      })
      .then(function (n) { $('backupMsg').textContent = n ? n + ' élément(s) récupéré(s) depuis le Sheet.' : 'Rien de nouveau : votre appli est déjà à jour avec le Sheet.'; })
      .catch(function (err) { $('backupMsg').textContent = 'Échec : ' + ((err && err.message) || err); });
  }

  /* ---------- Rendu ---------- */
  function currentState() { return C.computeState(events); }

  function renderBadge() {
    var b = $('syncBadge'), pend = pendingEvents().length, configured = cfg.url && cfg.token, txt, warn = false;
    var stale = cfg.lastSyncOk ? (Date.now() - cfg.lastSyncOk) > 3 * 86400000 : true;
    if (!configured) { txt = '⚠ Sauvegarde Sheet à configurer'; warn = true; }
    else if (syncing) { txt = '⏳ Synchronisation…'; }
    else if (pend > 0) { txt = '⏳ ' + pend + ' non envoyé' + (pend > 1 ? 's' : ''); warn = stale; }
    else { txt = '✓ Sauvegardé'; }
    b.textContent = txt; b.className = 'badge' + (warn ? ' warn' : '');
  }

  function render() {
    try { doRender(); } catch (err) { showFatal(err); }
  }

  function doRender() {
    var st = currentState(), sessions = st.sessions, s = C.stats(sessions, st.settings, st.restocks);
    function k(v, l) { return '<div class="kpi"><b>' + v + '</b><span>' + l + '</span></div>'; }
    $('kpis').innerHTML =
      k(fr(s.n), 'séances') + k(fr(s.players), 'joueurs au total') + k(fr(s.avgPlayers, 1), 'joueurs par séance') +
      k(fr(s.tubes) + ' <small style="font-size:12px;font-weight:400">(' + fr(s.vol) + ' vol.)</small>', 'tubes mis à dispo') +
      k(fr(s.volSession, 1), 'volants par séance') + k(fr(s.volPlayer, 2), 'volant / joueur / séance') +
      k(eur2(s.costPlayer), 'coût / joueur / séance') + k(eur2(s.spent), 'dépensé en volants');
    $('proj').innerHTML =
      k(fr(s.tubesWeek, 2), 'tubes par semaine') + k(fr(s.tubesYear, 0), 'tubes par an (52 sem.)') + k(eur(s.budgetYear), 'budget volants / an') +
      k(s.stock == null ? 'à renseigner' : fr(s.stock) + ' tubes', 'stock restant') + k(s.weeksLeft == null ? '–' : fr(s.weeksLeft, 0) + ' sem.', 'autonomie estimée');

    // Séances
    var list = $('list');
    if (!sessions.length) { list.innerHTML = '<div class="empty">Aucune séance pour le moment.</div>'; }
    else {
      var max = Math.max.apply(null, sessions.map(function (x) { return x.players; }).concat([1]));
      var sorted = sessions.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1); });
      list.innerHTML = sorted.map(function (x) {
        var pct = Math.round(x.players / max * 100);
        var tag = x.tubes > 0 ? '<div style="margin-top:4px"><span class="tag">+' + x.tubes + ' tube' + (x.tubes > 1 ? 's' : '') + '</span></div>' : '';
        var del = pendingDelete === x.id
          ? '<button class="small danger" data-act="del" data-id="' + esc(x.id) + '">Confirmer</button>'
          : '<button class="small" data-act="del" data-id="' + esc(x.id) + '" aria-label="Supprimer">✕</button>';
        return '<div class="item"><div class="d">' + fmtDate(x.date) + '</div>' +
          '<div><div class="bar"><i style="width:' + pct + '%"></i><em>' + x.players + ' joueurs</em></div>' + tag + '</div>' +
          '<div class="acts"><button class="small" data-act="edit" data-id="' + esc(x.id) + '">Modifier</button>' + del + '</div></div>';
      }).join('');
    }

    // Jours sans séance saisie
    var miss = C.missingSessionDates(sessions, st.noSessions, today());
    $('missingCard').hidden = !miss.length;
    if (miss.length) {
      $('missingTitle').textContent = 'À régler : ' + miss.length + ' jour' + (miss.length > 1 ? 's' : '') + ' sans séance saisie';
      $('missingList').innerHTML = miss.slice().reverse().map(function (d) {
        return '<div class="item" style="grid-template-columns:1fr auto"><div class="d">' + C.longDate(d) + '</div>' +
          '<div class="acts"><button class="small primary" data-mact="add" data-date="' + d + '">Ajouter</button>' +
          '<button class="small" data-mact="none" data-date="' + d + '">Pas de séance</button></div></div>';
      }).join('');
    }

    // Tubes mis à disposition
    var rl = $('restockList');
    if (!st.restocks.length) { rl.innerHTML = '<div class="empty">Aucun restock enregistré.</div>'; }
    else {
      rl.innerHTML = st.restocks.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1); }).map(function (r) {
        var del = pendingDelete === r.id
          ? '<button class="small danger" data-ract="del" data-id="' + esc(r.id) + '">Confirmer</button>'
          : '<button class="small" data-ract="del" data-id="' + esc(r.id) + '" aria-label="Supprimer">✕</button>';
        return '<div class="item" style="grid-template-columns:86px 1fr auto"><div class="d">' + fmtDate(r.date) + '</div>' +
          '<div><span class="tag">+' + r.tubes + ' tube' + (r.tubes > 1 ? 's' : '') + '</span> <span class="sub">' + (r.tubes * C.PER_TUBE) + ' volants</span></div>' +
          '<div class="acts">' + del + '</div></div>';
      }).join('');
    }

    // Réglages (sans écraser un champ en cours de saisie)
    var ae = document.activeElement && document.activeElement.id;
    if (ae !== 'sPrice') $('sPrice').value = st.settings.tubePrice == null ? '' : st.settings.tubePrice;
    if (ae !== 'sStock') $('sStock').value = st.settings.stockStart == null ? '' : st.settings.stockStart;
    if (ae !== 'sBought') $('sBought').value = st.settings.bought || '';

    renderBadge(); renderBackupInfo(); renderHistory();
  }

  function renderBackupInfo() {
    var pend = pendingEvents().length, parts = [];
    parts.push(cfg.lastSyncOk ? 'Dernière synchronisation : ' + fmtDateTime(cfg.lastSyncOk) + '.' : 'Aucune synchronisation réussie pour l\'instant.');
    parts.push(pend ? pend + ' modification(s) pas encore envoyée(s) au Sheet.' : 'Tout est envoyé au Sheet.');
    parts.push('Journal : ' + events.length + ' événement(s) conservés sur ce téléphone.');
    if (persisted === false) parts.push('Le navigateur peut vider ce stockage en cas de manque de place : gardez la synchronisation Sheet active.');
    $('backupInfo').textContent = parts.join(' ');
    if (document.activeElement !== $('cUrl')) $('cUrl').value = cfg.url;
    if (document.activeElement !== $('cToken')) $('cToken').value = cfg.token;
  }

  function renderHistory() {
    var fiches = events.filter(function (e) { return e.type === 'session' || e.type === 'restock' || e.type === 'noSession'; });
    var first = {};
    fiches.slice().sort(C.cmpEvents).forEach(function (e) { var k = e.type + (e.sid || e.rid || e.nid); if (!(k in first)) first[k] = e.id; });
    var recent = fiches.slice().sort(C.cmpEvents).reverse().slice(0, 30);
    $('hist').innerHTML = recent.length ? recent.map(function (e) {
      var label = e.deleted ? 'Suppression' : (first[e.type + (e.sid || e.rid || e.nid)] === e.id ? 'Ajout' : 'Modification');
      var what = e.type === 'restock' ? 'Restock +' + e.tubes + ' tube' + (e.tubes > 1 ? 's' : '') : e.type === 'noSession' ? 'Pas de séance' : 'Séance ' + e.players + ' joueurs';
      return '<div class="hist"><div><b>' + label + '</b> · ' + fmtDate(e.date) + ' · ' + what + '<br><span class="sub">' + fmtDateTime(e.ts) + '</span></div>' +
        '<button class="small" data-hid="' + esc(e.id) + '">Rétablir</button></div>';
    }).join('') : '<div class="empty">Aucun historique.</div>';
  }

  /* ---------- Actions ---------- */
  function sessionEvent(sid, d, deleted) {
    return { id: newId(), ts: new Date().toISOString(), type: 'session', sid: sid, date: d.date, players: d.players, tubes: d.tubes || 0, deleted: !!deleted };
  }
  function restockEvent(rid, d, deleted) {
    return { id: newId(), ts: new Date().toISOString(), type: 'restock', rid: rid, date: d.date, tubes: d.tubes, deleted: !!deleted };
  }
  function noSessionEvent(date, deleted) {
    return { id: newId(), ts: new Date().toISOString(), type: 'noSession', nid: 'n-' + date, date: date, deleted: !!deleted };
  }
  function ficheEvent(src, deleted) {
    return src.type === 'restock' ? restockEvent(src.rid, src, deleted)
      : src.type === 'noSession' ? noSessionEvent(src.date, deleted) : sessionEvent(src.sid, src, deleted);
  }
  function newKey(prefix) { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }

  var editingTubes = 0, restockDate = today();

  function closePanels() { $('sessionPanel').hidden = true; $('restockPanel').hidden = true; $('actions').hidden = false; warnAcked = false; editingId = null; }

  /* ----- Séance ----- */
  function setSessionDate(iso) { $('fDate').value = iso; $('dateLabel').textContent = C.longDate(iso); }

  function openSessionPanel(sess, presetDate) {
    closePanels();
    editingId = sess ? sess.id : null; editingTubes = sess ? sess.tubes : 0; warnAcked = false;
    setSessionDate(sess ? sess.date : (presetDate || C.defaultSessionDate(today())));
    $('fDate').hidden = true; $('btnChangeDate').hidden = false;
    $('fPlayers').value = sess ? sess.players : '';
    $('formTitle').textContent = sess ? 'Modifier la séance' : 'Nouvelle séance';
    $('saveBtn').textContent = sess ? 'Enregistrer' : 'Enregistrer la séance';
    $('formMsg').hidden = true;
    $('actions').hidden = true; $('sessionPanel').hidden = false;
    $('fPlayers').focus();   // tout de suite, dans le geste de l'utilisateur : le clavier numérique s'ouvre
    $('sessionPanel').scrollIntoView({ block: 'center' });
    setTimeout(function () { $('fPlayers').focus(); if ($('fPlayers').select) $('fPlayers').select(); }, 80);
  }
  function showFormMsg(lines) { var m = $('formMsg'); m.innerHTML = lines.map(esc).join('<br>'); m.hidden = !lines.length; }

  $('btnNewSession').addEventListener('click', function () { openSessionPanel(null); });
  $('btnChangeDate').addEventListener('click', function () { $('fDate').hidden = false; this.hidden = true; $('fDate').focus(); });
  $('fDate').addEventListener('change', function () { if ($('fDate').value) setSessionDate($('fDate').value); warnAcked = false; });
  $('fPlayers').addEventListener('input', function () { warnAcked = false; $('saveBtn').textContent = editingId ? 'Enregistrer' : 'Enregistrer la séance'; });
  $('cancelBtn').addEventListener('click', closePanels);

  $('form').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = { date: $('fDate').value, players: parseInt($('fPlayers').value, 10), tubes: editingTubes };
    var st = currentState();
    var v = C.validateSession(d, today(), st.sessions, editingId);
    if (v.errors.length) { showFormMsg(v.errors); warnAcked = false; return; }
    if (v.warnings.length && !warnAcked) {
      showFormMsg(v.warnings.concat(['Appuyez de nouveau pour confirmer.'])); warnAcked = true;
      $('saveBtn').textContent = 'Confirmer quand même'; return;
    }
    var wasEditing = editingId, sid = editingId || newKey('s-');
    var ev = sessionEvent(sid, d, false);
    closePanels();
    addEvents([ev]).then(function (ok) {
      var prev = C.previousVersion(events, sid, ev.id);
      var msg = (wasEditing ? 'Séance modifiée' : C.longDate(d.date) + ' : ' + d.players + ' joueurs enregistrés');
      toast(ok ? msg : 'Enregistrée (stockage de secours uniquement)', 'Annuler', function () {
        if (prev) addEvents([sessionEvent(sid, prev, !!prev.deleted)]);
        else addEvents([sessionEvent(sid, d, true)]);
      });
    });
  });

  /* ----- Restock ----- */
  function openRestockPanel() {
    closePanels();
    restockDate = today();
    $('restockDateLabel').textContent = 'Aujourd\'hui · ' + C.longDate(restockDate);
    $('rDate').hidden = true; $('rChangeDate').hidden = false; $('rDate').value = restockDate;
    $('rTubes').value = 1; $('restockMsg').hidden = true; warnAcked = false;
    $('restockSave').textContent = 'Ajouter les tubes';
    $('actions').hidden = true; $('restockPanel').hidden = false;
    $('restockPanel').scrollIntoView({ block: 'center' });
  }
  function bumpTubes(n) { var v = parseInt($('rTubes').value, 10); if (isNaN(v)) v = 0; $('rTubes').value = Math.max(1, Math.min(40, v + n)); warnAcked = false; $('restockSave').textContent = 'Ajouter les tubes'; }
  $('btnNewRestock').addEventListener('click', openRestockPanel);
  $('rMinus').addEventListener('click', function () { bumpTubes(-1); });
  $('rPlus').addEventListener('click', function () { bumpTubes(1); });
  $('rChangeDate').addEventListener('click', function () { $('rDate').hidden = false; this.hidden = true; $('rDate').focus(); });
  $('rDate').addEventListener('change', function () { if ($('rDate').value) { restockDate = $('rDate').value; $('restockDateLabel').textContent = C.longDate(restockDate); } warnAcked = false; });
  $('rTubes').addEventListener('input', function () { warnAcked = false; $('restockSave').textContent = 'Ajouter les tubes'; });
  $('restockCancel').addEventListener('click', closePanels);

  $('restockForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var d = { date: restockDate, tubes: parseInt($('rTubes').value, 10) };
    var v = C.validateRestock(d, today()), m = $('restockMsg');
    if (v.errors.length) { m.innerHTML = v.errors.map(esc).join('<br>'); m.hidden = false; warnAcked = false; return; }
    if (v.warnings.length && !warnAcked) {
      m.innerHTML = v.warnings.concat(['Appuyez de nouveau pour confirmer.']).map(esc).join('<br>'); m.hidden = false; warnAcked = true;
      $('restockSave').textContent = 'Confirmer quand même'; return;
    }
    var rid = newKey('r-'), ev = restockEvent(rid, d, false);
    closePanels();
    addEvents([ev]).then(function (ok) {
      toast(ok ? '+' + d.tubes + ' tube' + (d.tubes > 1 ? 's' : '') + ' mis à disposition' : 'Enregistré (stockage de secours uniquement)', 'Annuler', function () {
        addEvents([restockEvent(rid, d, true)]);
      });
    });
  });

  /* ----- Listes : modifier / supprimer ----- */
  $('list').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var id = b.getAttribute('data-id'), act = b.getAttribute('data-act');
    var x = currentState().sessions.filter(function (s) { return s.id === id; })[0];
    if (!x) return;
    if (act === 'edit') { openSessionPanel(x); }
    else if (act === 'del') {
      if (pendingDelete !== id) { pendingDelete = id; render(); setTimeout(function () { if (pendingDelete === id) { pendingDelete = null; render(); } }, 4000); return; }
      pendingDelete = null;
      addEvents([sessionEvent(id, x, true)]).then(function () {
        toast('Séance supprimée', 'Annuler', function () { addEvents([sessionEvent(id, x, false)]); });
      });
    }
  });

  $('restockList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b || b.getAttribute('data-ract') !== 'del') return;
    var id = b.getAttribute('data-id');
    var x = currentState().restocks.filter(function (r) { return r.id === id; })[0];
    if (!x) return;
    if (pendingDelete !== id) { pendingDelete = id; render(); setTimeout(function () { if (pendingDelete === id) { pendingDelete = null; render(); } }, 4000); return; }
    pendingDelete = null;
    addEvents([restockEvent(id, x, true)]).then(function () {
      toast('Restock supprimé', 'Annuler', function () { addEvents([restockEvent(id, x, false)]); });
    });
  });

  $('missingList').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var date = b.getAttribute('data-date'), act = b.getAttribute('data-mact');
    if (act === 'add') { openSessionPanel(null, date); }
    else if (act === 'none') {
      addEvents([noSessionEvent(date, false)]).then(function () {
        toast(C.longDate(date) + ' : pas de séance', 'Annuler', function () { addEvents([noSessionEvent(date, true)]); });
      });
    }
  });
  $('btnIgnoreAll').addEventListener('click', function () {
    var dates = C.missingSessionDates(currentState().sessions, currentState().noSessions, today());
    if (!dates.length) return;
    addEvents(dates.map(function (d) { return noSessionEvent(d, false); })).then(function () {
      toast(dates.length + ' jour(s) marqué(s) « pas de séance »', 'Annuler', function () { addEvents(dates.map(function (d) { return noSessionEvent(d, true); })); });
    });
  });

  $('hist').addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var ev = events.filter(function (x) { return x.id === b.getAttribute('data-hid'); })[0];
    if (!ev) return;
    addEvents([ficheEvent(ev, false)]).then(function () { toast('Version rétablie'); });
  });

  // Réglages : un événement « settings » par changement réel
  var settingsTimer = null;
  function onSettingsInput() {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(function () {
      var pr = $('sPrice').value, st = $('sStock').value, bo = $('sBought').value;
      var next = { tubePrice: pr === '' ? C.DEFAULT_SETTINGS.tubePrice : parseFloat(pr), stockStart: st === '' ? null : parseInt(st, 10), bought: bo === '' ? 0 : parseInt(bo, 10) };
      if ([next.tubePrice, next.bought].some(isNaN) || (next.stockStart != null && isNaN(next.stockStart)) || next.tubePrice < 0 || next.bought < 0 || (next.stockStart != null && next.stockStart < 0)) return;
      var cur = currentState().settings;
      if (cur.tubePrice === next.tubePrice && cur.stockStart === next.stockStart && cur.bought === next.bought) return;
      addEvents([{ id: newId(), ts: new Date().toISOString(), type: 'settings', tubePrice: next.tubePrice, stockStart: next.stockStart, bought: next.bought }]);
    }, 700);
  }
  ['sPrice', 'sStock', 'sBought'].forEach(function (id) { $(id).addEventListener('input', onSettingsInput); });

  /* ---------- Sauvegarde : configuration, export, import ---------- */
  $('syncBadge').addEventListener('click', function () {
    if (!cfg.url || !cfg.token) { $('backupCard').open = true; $('backupCard').scrollIntoView({ behavior: 'smooth' }); return; }
    sync().then(function (r) { toast(r.ok ? 'Sauvegarde à jour' : 'Échec : ' + r.reason); });
  });
  $('btnSync').addEventListener('click', function () {
    cfg.url = $('cUrl').value.trim(); cfg.token = $('cToken').value.trim(); cfgSave();
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(cfg.url)) { $('backupMsg').textContent = 'L\'adresse doit ressembler à https://script.google.com/macros/s/…/exec'; return; }
    if (!cfg.token) { $('backupMsg').textContent = 'Renseignez le code secret.'; return; }
    $('backupMsg').textContent = 'Synchronisation…';
    sync().then(function (r) {
      $('backupMsg').textContent = r.ok ? 'Synchronisation réussie : ' + events.length + ' événement(s) dans le Sheet.' : 'Échec : ' + r.reason;
    });
  });
  $('btnRestore').addEventListener('click', function () {
    cfg.url = $('cUrl').value.trim(); cfg.token = $('cToken').value.trim(); cfgSave(); restoreFromSheet();
  });

  function download(name, text, type) {
    var blob = new Blob([text], { type: type }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function exportJson() {
    download('volants-' + today() + '.json', JSON.stringify({ app: 'volants', version: 1, exportedAt: new Date().toISOString(), events: events.map(strip) }, null, 1), 'application/json');
  }
  $('btnExport').addEventListener('click', exportJson);
  $('btnCsv').addEventListener('click', function () { download('volants-' + today() + '.csv', C.csv(currentState().sessions, currentState().restocks), 'text/csv'); });
  $('btnImport').addEventListener('click', function () { $('fileImport').click(); });
  $('fileImport').addEventListener('change', function () {
    var f = this.files && this.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(rd.result), list = Array.isArray(j) ? j : j.events;
        if (!Array.isArray(list)) throw new Error('format');
        var added = C.mergeEvents(events, list);
        if (!added.length) { $('backupMsg').textContent = 'Fichier lu : rien de nouveau à importer.'; return; }
        addEvents(added, false).then(function () { $('backupMsg').textContent = added.length + ' élément(s) importé(s).'; });
      } catch (err) { $('backupMsg').textContent = 'Fichier non reconnu : rien n\'a été modifié.'; }
    };
    rd.readAsText(f); this.value = '';
  });

  /* ---------- Mode sécurité : si quelque chose plante, les données restent exportables ---------- */
  function showFatal(err) {
    var f = $('fatal');
    f.hidden = false;
    f.innerHTML = 'Un problème est survenu dans l\'affichage, mais vos données ne sont pas touchées (' + events.length + ' événements conservés).<br>' +
      '<div class="btns"><button class="small" id="fxExport">Exporter mes données</button><button class="small" id="fxReload">Recharger</button></div>';
    var a = document.getElementById('fxExport'), r = document.getElementById('fxReload');
    if (a) a.onclick = exportJson;
    if (r) r.onclick = function () { location.reload(); };
    try { console.error(err); } catch (e) {}
  }
  window.addEventListener('error', function (e) { showFatal(e.error || e.message); });
  window.addEventListener('unhandledrejection', function (e) { showFatal(e.reason); });

  /* ---------- Démarrage ---------- */
  function init() {
    cfgLoad();
    return idbOpen().then(function (d) { db = d; return idbAll(); }).then(function (fromIdb) {
      // Fusion IndexedDB + miroir : si l'un des deux est abîmé ou vidé, l'autre le complète.
      events = fromIdb.slice();
      var extra = C.mergeEvents(events, mirrorLoad());
      extra.forEach(function (e) { events.push(e); });
      var toPersist = extra.slice();
      if (!events.length) {
        SEED.forEach(function (s) {
          var e = { id: 'seed-' + s[0], ts: SEED_TS, type: 'session', sid: 'seed-' + s[0], date: s[1], players: s[2], tubes: 0, deleted: false, synced: false };
          events.push(e); toPersist.push(e);
        });
        SEED_RESTOCKS.forEach(function (r) {
          var e = { id: 'seed-r-' + r[0], ts: SEED_TS, type: 'restock', rid: 'seed-r-' + r[0], date: r[1], tubes: r[2], deleted: false, synced: false };
          events.push(e); toPersist.push(e);
        });
      }
      mirrorSave();
      return idbPut(toPersist);
    }).then(function () {
      render();
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().then(function (p) { persisted = p; renderBackupInfo(); }).catch(function () {});
      }
      if (cfg.url && cfg.token) scheduleSync(800);
    });
  }

  window.addEventListener('online', function () { scheduleSync(500); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible' && pendingEvents().length) scheduleSync(800); });

  if ('serviceWorker' in navigator) { window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () {}); }); }

  init().catch(showFatal);
  window.__volants = { events: function () { return events; }, sync: sync };
})();
