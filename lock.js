/* Verrou d'entrée de l'appli : une seule porte pour les volants et la compta.
   - Déverrouillage par l'empreinte ou le code de verrouillage du téléphone (WebAuthn, comme une clé d'accès).
   - Verrouillé à chaque lancement, et après 2 minutes en arrière-plan.
   - Sans mot de passe à retenir : si l'empreinte échoue, Android propose le code du téléphone.
   Ce verrou protège de la curiosité d'un tiers qui prend l'appli en main. La vraie protection des données reste
   le verrouillage du téléphone et le code secret de la sauvegarde. */
(function () {
  'use strict';
  var KEY = 'lock-v2', OLD_KEY = 'lock-v1', IDLE_MS = 120000;
  var unlocked = false, hiddenAt = 0, root = null;
  var $ = function (id) { return document.getElementById(id); };

  function b64(buf) { var s = ''; var a = new Uint8Array(buf); for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); }
  function unb64(s) { return Uint8Array.from(atob(s), function (c) { return c.charCodeAt(0); }); }
  function read(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch (e) { return null; } }
  function stored() {
    var s = read(KEY);
    if (s) return s;
    var old = read(OLD_KEY);                       // ancienne version (phrase secrète) : on reprend l'empreinte déjà enregistrée
    if (old && old.cred) { s = { v: 2, cred: old.cred }; save(s); return s; }
    return null;
  }
  function save(o) { localStorage.setItem(KEY, JSON.stringify(o)); }
  function msg(id, text) { var m = $(id); m.textContent = text; m.hidden = !text; }
  function rnd(n) { return crypto.getRandomValues(new Uint8Array(n)); }
  function bioAvailable() {
    return (window.PublicKeyCredential && navigator.credentials && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)
      ? PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().catch(function () { return false; })
      : Promise.resolve(false);
  }

  function show(mode) {
    root.hidden = !mode;
    $('lockSetup').hidden = mode !== 'setup';
    $('lockUnlock').hidden = mode !== 'unlock';
    document.body.classList.toggle('locked', !!mode);
  }
  function unlockOk() {
    unlocked = true; show(null);
    window.dispatchEvent(new Event('app-unlocked'));
  }

  /* ----- premier lancement : enregistrer l'empreinte / le code du téléphone ----- */
  function setup() {
    msg('lockSetMsg', '');
    bioAvailable().then(function (ok) {
      if (!ok) { save({ v: 2, cred: null, off: true }); return unlockOk(); }   // téléphone sans verrou possible : pas de verrou
      return navigator.credentials.create({ publicKey: {
        challenge: rnd(32), rp: { name: 'La Plume Beynatoise' },
        user: { id: rnd(16), name: 'tresorerie', displayName: 'Trésorerie' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000
      } }).then(function (c) { save({ v: 2, cred: b64(c.rawId) }); unlockOk(); },
        function () { msg('lockSetMsg', 'Le verrou n\'a pas pu être activé. Réessayez, ou continuez sans verrou.'); });
    });
  }
  function skip() { save({ v: 2, cred: null, off: true }); unlockOk(); }

  /* ----- déverrouillage ----- */
  function unlockByBio() {
    var s = stored(); if (!s || !s.cred) return;
    navigator.credentials.get({ publicKey: {
      challenge: rnd(32), allowCredentials: [{ type: 'public-key', id: unb64(s.cred) }],
      userVerification: 'required', timeout: 60000
    } }).then(function () { msg('lockMsg', ''); unlockOk(); }, function () { msg('lockMsg', 'Non reconnu. Appuyez pour réessayer.'); });
  }

  function init() {
    root = $('lock'); if (!root) return;
    $('lockSetBtn').addEventListener('click', setup);
    $('lockSkipBtn').addEventListener('click', skip);
    $('lockBioBtn').addEventListener('click', unlockByBio);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) hiddenAt = Date.now();
      else if (unlocked && hiddenAt && Date.now() - hiddenAt > IDLE_MS) { unlocked = false; start(); }
    });
    start();
  }

  function start() {
    var s = stored();
    if (!s) return show('setup');
    if (s.off || !s.cred) return unlockOk();
    show('unlock');
    setTimeout(unlockByBio, 150);
  }

  window.AppLock = { isUnlocked: function () { return unlocked; } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
