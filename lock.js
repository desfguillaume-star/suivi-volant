/* Verrou d'entrée de l'appli : une seule porte pour les volants et la compta.
   - Phrase secrète (au moins 12 caractères) : on ne stocke que son empreinte PBKDF2 (+ sel), jamais la phrase.
   - Empreinte / passkey du téléphone (facultatif) : déverrouillage rapide via WebAuthn.
   - Verrouillé à chaque lancement, et après 2 minutes en arrière-plan. */
(function () {
  'use strict';
  var KEY = 'lock-v1', IDLE_MS = 120000;
  var unlocked = false, hiddenAt = 0, root = null;
  var enc = new TextEncoder();
  var $ = function (id) { return document.getElementById(id); };

  function b64(buf) { var s = ''; var a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function stored() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(o) { localStorage.setItem(KEY, JSON.stringify(o)); }
  function derive(phrase, salt) {
    return crypto.subtle.importKey('raw', enc.encode(phrase), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) { return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 310000, hash: 'SHA-256' }, k, 256); })
      .then(b64);
  }
  function msg(id, text) { var m = $(id); m.textContent = text; m.hidden = !text; }
  function bioAvailable() {
    return !!(window.PublicKeyCredential && navigator.credentials && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)
      ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; })
      : Promise.resolve(false);
  }
  function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }

  function show(mode) {
    root.hidden = !mode;
    $('lockSetup').hidden = mode !== 'setup';
    $('lockUnlock').hidden = mode !== 'unlock';
    document.body.classList.toggle('locked', !!mode);
  }
  function unlockOk() {
    unlocked = true; show(null);
    $('lockPhrase').value = ''; $('lockNew').value = ''; $('lockNew2').value = '';
    window.dispatchEvent(new Event('app-unlocked'));
  }

  /* ----- création de la phrase (premier lancement) ----- */
  function setup() {
    var p = $('lockNew').value.trim(), p2 = $('lockNew2').value.trim();
    if (p.length < 12) return msg('lockSetMsg', 'Au moins 12 caractères (ex. 3 ou 4 mots).');
    if (p !== p2) return msg('lockSetMsg', 'Les deux phrases ne correspondent pas.');
    msg('lockSetMsg', '');
    var salt = rnd(16);
    var wantBio = $('lockBio').checked;
    derive(p, salt).then(function (h) {
      var entry = { v: 1, salt: b64(salt), hash: h, cred: null };
      if (!wantBio) { save(entry); return unlockOk(); }
      return navigator.credentials.create({ publicKey: {
        challenge: rnd(32), rp: { name: 'La Plume Beynatoise' },
        user: { id: rnd(16), name: 'tresorerie', displayName: 'Trésorerie' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000
      } }).then(function (c) { entry.cred = b64(c.rawId); }, function () { /* pas d'empreinte : phrase seule */ })
        .then(function () { save(entry); unlockOk(); });
    });
  }

  /* ----- déverrouillage ----- */
  function unlockByPhrase() {
    var s = stored(), p = $('lockPhrase').value.trim();
    if (!s || !p) return;
    derive(p, unb64(s.salt)).then(function (h) {
      if (h === s.hash) { msg('lockMsg', ''); unlockOk(); }
      else { msg('lockMsg', 'Phrase incorrecte.'); setTimeout(function () { $('lockPhrase').select(); }, 50); }
    });
  }
  function unlockByBio() {
    var s = stored(); if (!s || !s.cred) return;
    navigator.credentials.get({ publicKey: {
      challenge: rnd(32), allowCredentials: [{ type: 'public-key', id: unb64(s.cred) }],
      userVerification: 'required', timeout: 60000
    } }).then(function () { msg('lockMsg', ''); unlockOk(); }, function () { msg('lockMsg', 'Empreinte non reconnue. Utilisez la phrase.'); });
  }

  function init() {
    root = $('lock'); if (!root) return;
    $('lockSetBtn').addEventListener('click', setup);
    $('lockPhraseBtn').addEventListener('click', unlockByPhrase);
    $('lockPhrase').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlockByPhrase(); });
    $('lockBioBtn').addEventListener('click', unlockByBio);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) hiddenAt = Date.now();
      else if (unlocked && hiddenAt && Date.now() - hiddenAt > IDLE_MS) { unlocked = false; start(); }
    });
    start();
  }

  function start() {
    var s = stored();
    if (!s) { show('setup'); bioAvailable().then(function (ok) { $('lockBio').parentNode.hidden = !ok; }); return; }
    show('unlock');
    $('lockBioBtn').hidden = !s.cred;
    if (s.cred) setTimeout(unlockByBio, 150);
    setTimeout(function () { $('lockPhrase').focus(); }, 100);
  }

  window.AppLock = { isUnlocked: function () { return unlocked; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
