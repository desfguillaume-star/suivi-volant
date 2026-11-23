/* Logique pure du suivi des volants (aucun accès au navigateur : testable avec Node).
   Principe : un JOURNAL d'événements en ajout seul. L'état affiché est calculé à partir du journal.
   Rien n'est jamais écrasé ni effacé : une modification ou une suppression est un nouvel événement.
   Deux types de fiches : « session » (une séance, avec le nombre de joueurs) et « restock »
   (des tubes mis à disposition des joueurs à une date donnée). Le stock total chez le trésorier est à part. */
(function (root) {
  'use strict';
  var PER_TUBE = 12, WEEKS = 52;
  var DEFAULT_SETTINGS = { tubePrice: 23.95, stockStart: null, bought: 0 };
  var JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  var MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function cmpEvents(a, b) {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  function keyOf(e) { return e.type === 'session' ? 's:' + e.sid : e.type === 'restock' ? 'r:' + e.rid : e.type === 'noSession' ? 'n:' + e.nid : null; }

  /* Calcule l'état courant (séances + restocks + réglages) à partir du journal. */
  function computeState(events) {
    var sorted = events.slice().sort(cmpEvents);
    var latest = {}, settings = Object.assign({}, DEFAULT_SETTINGS);
    sorted.forEach(function (e) {
      if (e.type === 'settings') {
        settings = {
          tubePrice: e.tubePrice == null ? DEFAULT_SETTINGS.tubePrice : e.tubePrice,
          stockStart: e.stockStart == null ? null : e.stockStart,
          bought: e.bought || 0
        };
      } else { var k = keyOf(e); if (k) latest[k] = e; }
    });
    var sessions = [], restocks = [], noSessions = [];
    Object.keys(latest).forEach(function (k) {
      var e = latest[k];
      if (e.deleted) return;
      if (e.type === 'session') sessions.push({ id: e.sid, date: e.date, players: Number(e.players) || 0, tubes: Number(e.tubes) || 0 });
      else if (e.type === 'noSession') noSessions.push({ id: e.nid, date: e.date });
      else restocks.push({ id: e.rid, date: e.date, tubes: Number(e.tubes) || 0 });
    });
    return { sessions: sessions, restocks: restocks, noSessions: noSessions, settings: settings };
  }

  /* Dernière version d'une fiche (séance ou restock) avant un événement donné (pour « Annuler »). */
  function previousVersion(events, key, beforeEventId) {
    var list = events.filter(function (e) { return (e.type === 'session' && e.sid === key) || (e.type === 'restock' && e.rid === key) || (e.type === 'noSession' && e.nid === key); }).sort(cmpEvents);
    var prev = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === beforeEventId) break;
      prev = list[i];
    }
    return prev;
  }

  function daysBetween(a, b) {
    return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  }
  function addDays(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function weekday(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); } // 0 = dimanche
  function longDate(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    var j = JOURS[d.getUTCDay()];
    return j.charAt(0).toUpperCase() + j.slice(1) + ' ' + d.getUTCDate() + ' ' + MOIS[d.getUTCMonth()];
  }

  /* Date proposée pour une nouvelle séance : aujourd'hui si c'est lundi ou vendredi, sinon le dernier lundi/vendredi passé. */
  function defaultSessionDate(todayIso) {
    var d = todayIso;
    for (var i = 0; i < 7; i++) {
      var w = weekday(d);
      if (w === 1 || w === 5) return d;
      d = addDays(d, -1);
    }
    return todayIso;
  }

  /* Lundis et vendredis passés (depuis la première séance, aujourd'hui exclu) sans séance saisie
     et pas marqués « pas de séance ». */
  function missingSessionDates(sessions, noSessions, todayIso) {
    if (!sessions.length) return [];
    var have = {}, first = null;
    sessions.forEach(function (s) { have[s.date] = true; if (!first || s.date < first) first = s.date; });
    (noSessions || []).forEach(function (n) { have[n.date] = true; });
    var out = [], d = addDays(first, 1), end = addDays(todayIso, -1);
    while (d <= end && out.length < 60) {
      var w = weekday(d);
      if ((w === 1 || w === 5) && !have[d]) out.push(d);
      d = addDays(d, 1);
    }
    return out;
  }

  function stats(sessions, settings, restocks) {
    restocks = restocks || [];
    var n = sessions.length, players = 0, tubes = 0, first = null, last = null;
    sessions.forEach(function (s) {
      players += s.players; tubes += s.tubes;
      if (!first || s.date < first) first = s.date;
      if (!last || s.date > last) last = s.date;
    });
    restocks.forEach(function (r) { tubes += r.tubes; });
    var vol = tubes * PER_TUBE;
    var weeks = Math.max((first && last ? daysBetween(first, last) : 0) / 7, 1);
    var tubesWeek = n ? tubes / weeks : 0;
    var price = Number(settings.tubePrice) || 0;
    var stock = settings.stockStart == null ? null : (Number(settings.stockStart) || 0) + (Number(settings.bought) || 0) - tubes;
    return {
      n: n, players: players, tubes: tubes, vol: vol, first: first, last: last,
      avgPlayers: n ? players / n : 0,
      volSession: n ? vol / n : 0,
      volPlayer: players ? vol / players : 0,
      costPlayer: players ? tubes * price / players : 0,
      spent: tubes * price,
      tubesWeek: tubesWeek, tubesYear: tubesWeek * WEEKS, budgetYear: tubesWeek * WEEKS * price,
      price: price, stock: stock,
      weeksLeft: (stock != null && tubesWeek > 0) ? Math.max(stock, 0) / tubesWeek : null
    };
  }

  /* Contrôles de saisie d'une séance. Renvoie { errors: [], warnings: [] }. */
  function validateSession(d, todayIso, existing, editingId) {
    var errors = [], warnings = [];
    if (!DATE_RE.test(d.date || '') || isNaN(Date.parse(d.date))) errors.push('Date invalide.');
    if (!Number.isInteger(d.players) || d.players < 0 || d.players > 60) errors.push('Nombre de joueurs : entier entre 0 et 60.');
    if (d.tubes != null && (!Number.isInteger(d.tubes) || d.tubes < 0 || d.tubes > 20)) errors.push('Tubes : entier entre 0 et 20.');
    if (!errors.length) {
      if (daysBetween(todayIso, d.date) > 1) warnings.push('Cette date est dans le futur.');
      if (daysBetween(d.date, todayIso) > 120) warnings.push('Cette date date de plus de 4 mois.');
      var w = weekday(d.date);
      if (w !== 1 && w !== 5) warnings.push('Le ' + longDate(d.date).toLowerCase() + ' n\'est pas un jour habituel (lundi ou vendredi).');
      if (d.players > 35) warnings.push('Plus de 35 joueurs : est-ce bien le bon chiffre ?');
      var dup = (existing || []).some(function (s) { return s.date === d.date && s.id !== editingId; });
      if (dup) warnings.push('Une séance existe déjà à cette date.');
    }
    return { errors: errors, warnings: warnings };
  }

  /* Contrôles de saisie d'un restock. */
  function validateRestock(d, todayIso) {
    var errors = [], warnings = [];
    if (!DATE_RE.test(d.date || '') || isNaN(Date.parse(d.date))) errors.push('Date invalide.');
    if (!Number.isInteger(d.tubes) || d.tubes < 1 || d.tubes > 40) errors.push('Tubes : entier entre 1 et 40.');
    if (!errors.length) {
      if (daysBetween(todayIso, d.date) > 1) warnings.push('Cette date est dans le futur.');
      if (d.tubes > 10) warnings.push(d.tubes + ' tubes d\'un coup : est-ce bien le bon chiffre ?');
    }
    return { errors: errors, warnings: warnings };
  }

  /* Fusionne des événements reçus (import, Sheet) avec les locaux, sans doublon ni perte. */
  function mergeEvents(local, incoming) {
    var have = {};
    local.forEach(function (e) { have[e.id] = true; });
    var added = [];
    incoming.forEach(function (e) {
      if (!e || typeof e.id !== 'string' || typeof e.ts !== 'string' || (e.type !== 'session' && e.type !== 'settings' && e.type !== 'restock' && e.type !== 'noSession')) return;
      if (e.type === 'session' && (typeof e.sid !== 'string' || !DATE_RE.test(e.date || ''))) return;
      if (e.type === 'restock' && (typeof e.rid !== 'string' || !DATE_RE.test(e.date || ''))) return;
      if (e.type === 'noSession' && (typeof e.nid !== 'string' || !DATE_RE.test(e.date || ''))) return;
      if (have[e.id]) return;
      have[e.id] = true; added.push(e);
    });
    return added;
  }

  function csv(sessions, restocks) {
    var byDate = function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; };
    var rows = ['Séances', 'Date;Joueurs'];
    sessions.slice().sort(byDate).forEach(function (s) { rows.push([s.date, s.players].join(';')); });
    rows.push('', 'Tubes mis à disposition', 'Date;Tubes');
    (restocks || []).slice().sort(byDate).forEach(function (r) { rows.push([r.date, r.tubes].join(';')); });
    return rows.join('\n');
  }

  root.Core = {
    PER_TUBE: PER_TUBE, WEEKS: WEEKS, DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    cmpEvents: cmpEvents, computeState: computeState, previousVersion: previousVersion,
    stats: stats, validateSession: validateSession, validateRestock: validateRestock, mergeEvents: mergeEvents, csv: csv,
    daysBetween: daysBetween, addDays: addDays, weekday: weekday, longDate: longDate,
    defaultSessionDate: defaultSessionDate, missingSessionDates: missingSessionDates
  };
})(typeof window !== 'undefined' ? window : module.exports);
