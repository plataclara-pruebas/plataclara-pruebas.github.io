/* Plata Clara - cuenta y sincronización en la nube (Supabase).
   Si config.js está vacío, esto no hace nada y la app funciona igual que antes (solo local). */
(function () {
  'use strict';
  var C = window.PC_CONFIG || {};
  if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY) return;
  window.__pcCloud = true;   // el respaldo de 10 s de index.html ya no debe desbloquear: aqui se decide

  var SYNC_KEY = ((window.PC_CONFIG && window.PC_CONFIG.PREFIX) || '') + 'plataclara.sync', consentOK = false;
  var sb = null, user = null, pushTimer = null, pushing = false, pending = false, status = 'idle', applying = false;
  var successTimer = null, successVisible = false;
  var btn = document.getElementById('b-account');
  if (btn) btn.hidden = false;

  var root = document.documentElement;
  function lock() { root.classList.add('pc-lock'); }
  function unlock() { if (!root.classList.contains('pc-lock')) return; root.classList.remove('pc-lock'); if (ov) close(); }
  function wipeLocal() {
    applying = true;
    try { window.__pc.apply(window.__pc.empty()); } finally { applying = false; }
    setMark({});
    if (model) remember(); legacyPending = false; mergeNotice = '';
  }
  function getMark() { try { return JSON.parse(localStorage.getItem(SYNC_KEY)) || {}; } catch (e) { return {}; } }
  function setMark(o) { try { localStorage.setItem(SYNC_KEY, JSON.stringify(o)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function st() { return window.__pc && window.__pc.get(); }
  var model = window.PCSyncModel, snapshot = model.copy(st()), legacyPending = !!(getMark().legacyReview || (getMark().dirty && !st()._sync));
  if (legacyPending) { var oldMark = getMark(); oldMark.legacyReview = true; setMark(oldMark); }
  var actorKey = SYNC_KEY + '.device', actor;
  try { actor = localStorage.getItem(actorKey); if (!actor) { actor = crypto.randomUUID(); localStorage.setItem(actorKey, actor); } }
  catch (e) { actor = Math.random().toString(36).slice(2); }
  function remember() { snapshot = model.copy(st()); }
  var trackFailed = false;
  window.__pcTrack = function (data) {
    if (applying) return;
    try {
      var tracked = model.track(snapshot, data, getMark().at, actor, saveSeq + 1);
      data._sync = tracked._sync;
      ['moves', 'goals', 'debts', 'quicks', 'wallets', 'owed', 'xfers', 'recur'].forEach(function (k) { if (tracked[k]) data[k] = tracked[k]; });
      remember(); trackFailed = false;
    } catch (e) { trackFailed = true; setStatus('error'); } // el guardado local continúa aunque no pueda sincronizar
  };
  function hasUserData(d) { return !!(d && !d.demo && ((d.moves && d.moves.length) || (d.goals && d.goals.length) || (d.debts && d.debts.length))); }

  /* ---------- carga de la librería ---------- */
  function loadLib() {
    return new Promise(function (ok, fail) {
      if (window.supabase) return ok();
      var s = document.createElement('script');
      s.src = 'vendor/supabase-js-2.45.4.umd.js';   // autoalojado (MIT): sin terceros en el arranque
      // SRI: sha384 del archivo oficial 2.45.4 (idéntico al del paquete npm). Si cambias la versión, recalcula el hash y el nombre del archivo.
      s.integrity = 'sha384-0w2KAL2YHP6wKOkUDzkCDGgVvfmHnj02DHeQ6XcHOgTfFsGyonKOpShMH1x6nk9o';
      s.crossOrigin = 'anonymous';
      s.onload = ok; s.onerror = function () { fail(new Error('lib')); };
      document.head.appendChild(s);
    });
  }
  function client() {
    if (sb) return Promise.resolve(sb);
    return loadLib().then(function () {
      sb = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
      sb.auth.onAuthStateChange(function (ev, session) {
        var prev = user && user.id;
        user = session ? session.user : null;
        if (!user) { consentOK = false; window.PCPlan = null; window.PCAdmin = false; window.dispatchEvent(new Event('pcplan')); try { window.__pc.hReset(); } catch (e) {} }
        if (!user) { enterUid = null; entering = null; firstDone = false; }
        if (!user && ev === 'SIGNED_OUT') { lock(); accessSheet(); }
        paint();
        if (user && user.id !== prev && ev !== 'TOKEN_REFRESHED') { enter().then(function (ok) { if (ok) { syncPush(); setTimeout(offerPushOnce, 3000); setTimeout(offerInstallOnce, 4500); } }); }
      });
      return sb;
    });
  }

  /* ---------- sincronización ---------- */
  function setStatus(s, quiet) {
    clearTimeout(successTimer); successTimer = null;
    status = s; successVisible = s === 'ok' && !quiet; paint();
    if (s === 'ok' && !getMark().dirty) successTimer = setTimeout(function () {
      if (status === 'ok' && !getMark().dirty) { successVisible = false; mergeNotice = ''; paint(); }
    }, mergeNotice ? 8000 : 3000);
  }

  /* Fase A (2026-11): la marca guarda también "dirty" = hay cambios de este dispositivo sin subir (sobrevive a recargar).
     La subida es condicional: solo reemplaza la nube si sigue en la versión que este dispositivo conoce (updated_at = marca). */
  function tms(s) { var n = Date.parse(s || ''); return isNaN(n) ? 0 : n; }
  function markDirty() { var m = getMark(); if ((user && m.uid === user.id) || (!user && m.uid)) { m.dirty = true; m.count = (m.count || 0) + 1; setMark(m); } }
  var inflight = null, saveSeq = 0;   // saveSeq: guardados locales; si cambia durante una subida, sigue habiendo pendientes
  // Devuelve una promesa con 'ok' | 'error' | 'conflict'. force=true: reemplaza la nube (solo cuando la persona lo eligió o no hay versión previa).
  function pushNow(force, attempt) {
    attempt = attempt || 0;
    if (!user || !sb) return Promise.resolve('error');
    if (trackFailed) { setStatus('error'); return Promise.resolve('error'); }
    if (pushing) { pending = true; return inflight || Promise.resolve('ok'); }
    clearTimeout(pushTimer); pushTimer = null;
    var uid = user.id, mark = getMark(), now = new Date(Math.max(Date.now(), tms(mark.at) + 1)).toISOString(), mySeq = saveSeq, body;
    try { body = { data: model.normalize(st(), mark.at), updated_at: now }; }
    catch (e) { setStatus('error'); return Promise.resolve('error'); }
    pushing = true; setStatus('saving');
    var cond = !force && mark.uid === user.id && mark.at;
    var q = force === 'create'
      ? sb.from('user_data').insert({ user_id: user.id, data: body.data, updated_at: now }).select('updated_at')
      : cond
      ? sb.from('user_data').update(body).eq('user_id', user.id).eq('updated_at', mark.at).select('updated_at')
      : sb.from('user_data').upsert({ user_id: user.id, data: body.data, updated_at: now }).select('updated_at');
    inflight = q.then(function (r) {
      pushing = false; inflight = null;
      if (!user || user.id !== uid) return 'error';
      if (r.error && !(force === 'create' && r.error.code === '23505')) { setStatus('error'); return 'error'; }
      if (!r.data || !r.data.length) {                         // la nube cambió desde nuestra versión (u otra fila): no pisar
        return sb.from('user_data').select('data,updated_at').eq('user_id', user.id).maybeSingle().then(function (r2) {
          if (r2.error) { setStatus('error'); return 'error'; }
          if (!r2.data) return pushNow('create');              // INSERT evita pisar una primera subida concurrente
          if (attempt >= 4) { setStatus('error'); return 'error'; }
          return mergeRemote(r2.data, attempt + 1);
        }, function () { setStatus('error'); return 'error'; });
      }
      var newer = pending || saveSeq !== mySeq;
      setMark({ uid: user.id, at: r.data[0].updated_at, dirty: newer, count: newer ? getMark().count || 1 : 0 });
      legacyPending = false;
      setStatus('ok');
      if (newer) { pending = false; schedulePush(); }
      return 'ok';
    }, function () { pushing = false; inflight = null; setStatus('error'); return 'error'; });
    return inflight;
  }
  function schedulePush() { clearTimeout(pushTimer); setStatus(navigator.onLine === false ? 'offline' : 'saving'); pushTimer = setTimeout(function () { pushTimer = null; pushNow(); }, 1500); }

  /* La app llama a esto cada vez que guarda. */
  window.__pcPush = function () { if (!applying && (user || getMark().uid)) { saveSeq++; markDirty(); if (trackFailed) setStatus('error'); else if (user) schedulePush(); else setStatus('offline'); } };

  function applyRemote(row) {
    applying = true;
    try { window.__pc.apply(model.normalize(row.data, row.updated_at)); } finally { applying = false; }
    remember(); legacyPending = false; trackFailed = false;
    setMark({ uid: user.id, at: row.updated_at, dirty: false, count: 0 });
    setStatus('ok');
  }

  var mergeNotice = '';
  function mergeRemote(row, attempt) {
    if (legacyPending || !row.data._sync) { conflictSheet(row); return Promise.resolve('conflict'); }
    try {
      var mark = getMark(), result = model.merge(st(), row.data, mark.at, row.updated_at);
      applying = true;
      try { window.__pc.apply(result.data); } finally { applying = false; }
      remember();
      setMark({ uid: user.id, at: row.updated_at, dirty: true, count: mark.count || 1 });
      mergeNotice = result.conflicts ? 'Se juntaron los cambios. Para elementos editados en ambos dispositivos se conservó la edición más reciente.' : 'Se juntaron los cambios de tus dispositivos.';
      return pushNow(false, attempt);
    } catch (e) { if (e.code === 'UNVERSIONED') { conflictSheet(row); return Promise.resolve('conflict'); } setStatus('error'); return Promise.resolve('error'); }
  }

  window.PCSb = function () { return sb; };
  window.PCRpc = function (n, a) { return sb ? sb.rpc(n, a) : Promise.reject(new Error('sin nube')); };
  function loadPlan() {
    if (!sb || !user) return;
    sb.rpc('is_admin').then(function (r) { window.PCAdmin = r.data === true; window.dispatchEvent(new Event('pcplan')); }, function () {});
  }
  var reconciling = null;
  function reconcile() {
    if (reconciling) return reconciling;   // una sola lectura en curso (arranque, volver a la app y reconexion coinciden)
    loadPlan();
    if (!user || pushing) return inflight || Promise.resolve();
    var readAt = getMark().at, readUid = user.id;
    setStatus('saving');
    reconciling = sb.from('user_data').select('data,updated_at').eq('user_id', user.id).maybeSingle().then(function (r) {
      if (r.error) { setStatus('error'); return; }
      var row = r.data, mark = getMark(), local = st();
      if (!user || user.id !== readUid || mark.at !== readAt) return;
      if (!row) { return pushNow('create'); }                  // primera vez en la nube: insertar sin sobrescribir
      if (mark.uid === user.id) {                              // este dispositivo ya se había sincronizado antes
        if (row.updated_at !== mark.at) {                     // cualquier versión distinta, incluso con reloj atrasado
          if (mark.dirty) return mergeRemote(row, 0);
          return applyRemote(row);
        }
        if (mark.dirty === false) { setStatus('ok', true); return; } // al día y sin pendientes: nada que subir ni anunciar
        return pushNow();                                      // pendientes (o marca antigua sin "dirty"): subida condicional
      }
      if (!hasUserData(local)) return applyRemote(row);        // dispositivo sin datos propios: bajar la nube
      setStatus('ok'); chooseSheet(row);                       // ambos tienen datos: que decida la persona
    }, function () { setStatus('error'); }).then(function () { reconciling = null; firstReady(); try { window.__pc.maybeTour(); } catch (e) {} try { window.__pc.hInit(); } catch (e) {} });
    return reconciling;
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && user && !pushing && !pushTimer) reconcile();   // pushTimer vuelve a null tras cada subida
    else if (!document.hidden && !user && getMark().uid && navigator.onLine !== false) boot(true);
  });
  window.addEventListener('online', function () { if (user) reconcile(); else if (getMark().uid) boot(true); });
  window.addEventListener('offline', function () { if (user || getMark().uid) setStatus('offline'); });

  /* ---------- avisos de cuotas (notificaciones push) ---------- */
  var VAPID = C.VAPID_PUBLIC_KEY || '';
  var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  var standalone = (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
  function b64ToU8(s) {
    var p = '='.repeat((4 - s.length % 4) % 4), b = (s + p).replace(/-/g, '+').replace(/_/g, '/'), r = atob(b), o = new Uint8Array(r.length);
    for (var i = 0; i < r.length; i++) o[i] = r.charCodeAt(i);
    return o;
  }
  function myTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Lima'; } catch (e) { return 'America/Lima'; } }
  function currentSub() {
    if (!pushSupported()) return Promise.resolve(null);
    return navigator.serviceWorker.getRegistration().then(function (reg) { return reg && reg.active ? reg.pushManager.getSubscription() : null; }).catch(function () { return null; });
  }
  function enablePush() {
    return enablePush0().then(function () { return refreshNotif(); });
  }
  function enablePush0() {
    return Notification.requestPermission().then(function (p) {
      if (p !== 'granted') throw new Error('denied');
      return navigator.serviceWorker.ready;
    }).then(function (reg) {
      return reg.pushManager.getSubscription().then(function (s) {
        return s || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(VAPID) });
      });
    }).then(function (sub) {
      var j = sub.toJSON();
      return sb.from('push_subscriptions').upsert({ user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: myTz() }, { onConflict: 'endpoint' });
    }).then(function (r) { if (r.error) throw r.error; });
  }
  function disablePush() {
    return disablePush0().then(function () { return refreshNotif(); }, function (e) { refreshNotif(); throw e; });
  }
  function disablePush0() {
    return currentSub().then(function (s) {
      if (!s) return;
      return sb.from('push_subscriptions').delete().eq('endpoint', s.endpoint).then(function () { return s.unsubscribe(); });
    });
  }
  /* Si viajas o cambias de zona horaria, el aviso de las 10:00 sigue la hora de tu dispositivo. */
  /* El usuario gestiona las notificaciones desde el telefono: la app solo refleja ese permiso en el servidor. */
  var syncing = false;
  function syncPush() {
    if (syncing || !VAPID || !user || !pushSupported() || (isIOS && !standalone)) return Promise.resolve();
    syncing = true;
    var p = Notification.permission;
    var job = p === 'granted'
      ? enablePush0().then(function () { markPushAsked('activado-en-telefono'); })   // suscribe o actualiza (no muestra nada)
      : p === 'denied' ? disablePush0() : Promise.resolve();
    return job.catch(function () {}).then(function () { syncing = false; });
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && user) syncPush(); });
  function refreshPushTz() {
    if (!VAPID || !user || !pushSupported() || Notification.permission !== 'granted') return;
    currentSub().then(function (s) {
      if (!s) return;
      var j = s.toJSON();
      return sb.from('push_subscriptions').upsert({ user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, tz: myTz() }, { onConflict: 'endpoint' });
    }).catch(function () {});
  }
  function testPush() {
    return navigator.serviceWorker.ready.then(function (reg) {
      return reg.showNotification('Plata Clara', { body: 'Así te avisaremos: “Mañana vence tu cuota”.', icon: 'notif-icon.png', badge: 'badge.png', vibrate: [250, 120, 250, 120, 500], tag: 'prueba', data: { url: './#deudas' } });
    });
  }


  /* ---------- permiso de notificaciones: UNA sola vez por dispositivo, al terminar el tutorial ---------- */
  // Se marca en este dispositivo (localStorage) ANTES de preguntar: acepte, rechace, bloquee o cierre, no se vuelve a pedir.
  var ASK_KEY = 'pc-avisos-preguntado';
  function pushAsked() { try { return !!localStorage.getItem(ASK_KEY); } catch (e) { return true; } }
  function markPushAsked(v) { try { localStorage.setItem(ASK_KEY, v + '|' + new Date().toISOString()); } catch (e) {} }
  function canAskPush() { return !!(VAPID && user && pushSupported() && !(isIOS && !standalone)); }
  function requestPushNow() {   // llamar solo desde un toque del usuario (iOS y Chrome lo exigen)
    return enablePush0().then(function () { markPushAsked('aceptado'); return true; }, function () { markPushAsked('no-aceptado'); return false; });
  }
  function askPushOnce() {      // fin del tutorial
    if (!canAskPush() || pushAsked()) return Promise.resolve(false);
    if (Notification.permission === 'granted') return requestPushNow();              // ya activadas en el telefono
    if (Notification.permission === 'denied') { markPushAsked('bloqueado'); return Promise.resolve(false); }  // no se insiste
    markPushAsked('preguntado');
    return requestPushNow();
  }
  window.__pcPushOnce = function () { var p = askPushOnce(); p.then(function () { setTimeout(offerInstallOnce, 1500); }); return p; };
  // Cuentas que terminaron el tutorial antes de este cambio: una sola hoja, una sola vez por dispositivo.
  function offerPushOnce() {
    if (ov || document.getElementById('coach') || !canAskPush() || pushAsked()) return;
    var S0 = window.__pc && window.__pc.get && window.__pc.get();
    if (!S0 || !S0.tour) return;
    if (Notification.permission !== 'default') { askPushOnce(); return; }
    markPushAsked('ofrecido');
    show('<h2>Notificaciones de Plata Clara</h2><p>Te recordamos anotar tus movimientos a las 8:00, 12:00, 16:00 y 20:00 (hora de Perú).</p>' +
      '<div class="pc-m" style="min-height:0">Luego podrás activarlas o desactivarlas desde los ajustes de tu teléfono.</div>' +
      '<button class="pc-b" data-ya>Permitir notificaciones</button><button class="pc-b alt" data-no>Ahora no</button>', function (o) {
        o.querySelector('[data-ya]').onclick = function () { close(); requestPushNow(); };
        o.querySelector('[data-no]').onclick = function () { markPushAsked('ahora-no'); close(); };
      });
  }
  /* ---------- instalar como app (acceso directo): una sola oferta automatica por dispositivo; siempre disponible en Tu cuenta ---------- */
  var INST_KEY = 'pc-instalar-ofrecido', instEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); instEvt = e; });
  window.addEventListener('appinstalled', function () { instEvt = null; markInst('instalado'); });
  function instOffered() { try { return !!localStorage.getItem(INST_KEY); } catch (e) { return true; } }
  function markInst(v) { try { localStorage.setItem(INST_KEY, v + '|' + new Date().toISOString()); } catch (e) {} }
  function instKind() {
    var ua = navigator.userAgent || '';
    if (standalone) return 'ya';
    if (/FBAN|FBAV|FB_IAB|Instagram|musical_ly|Bytedance|TikTok|Line\/|Twitter|Snapchat|GSA\//i.test(ua)) return 'inapp';
    if (isIOS || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
      var m = ua.match(/OS (\d+)_(\d+)/), v = m ? +m[1] + m[2] / 100 : 99;
      if (/CriOS|FxiOS|EdgiOS/.test(ua)) return v >= 16.04 ? 'ios-otro' : 'ios-safari-req';
      return 'ios-safari';
    }
    if (instEvt) return 'prompt';
    if (/android/i.test(ua)) return 'android-menu';
    return 'pc';
  }
  var SHARE_ICO = '<svg width="16" height="18" viewBox="0 0 16 20" aria-hidden="true" style="vertical-align:-3px"><path d="M8 1v12M4 5l4-4 4 4M3 9H1.5v9.5h13V9H13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // Textos por idioma (los mismos 6 idiomas de la app). {S} = icono de Compartir.
  var IT = {
    es: { title: 'Ten Plata Clara en tu pantalla de inicio', why: 'Así la abres con un toque, como cualquier app.', whyIos: 'Así la abres con un toque, como cualquier app, y en iPhone es necesario para recibir notificaciones.',
      safari: ['Toca el botón <b>Compartir</b> {S} en la barra de Safari. Si no lo ves, toca primero <b>···</b>.', 'Baja y elige <b>Agregar a pantalla de inicio</b>.', 'Toca <b>Agregar</b>. Luego abre Plata Clara desde el nuevo ícono.'],
      otro: ['Toca el botón <b>Compartir</b> {S} junto a la barra de dirección (o en el menú <b>···</b>).', 'Elige <b>Agregar a pantalla de inicio</b>.', 'Toca <b>Agregar</b>. Si no aparece la opción, abre este enlace en <b>Safari</b> y repite los pasos.'],
      req: 'En tu versión de iPhone el acceso directo solo se crea desde <b>Safari</b>. Copia el enlace, ábrelo en Safari y elige Compartir → <b>Agregar a pantalla de inicio</b>.',
      inapp: 'Abriste el enlace dentro de otra app (Instagram, TikTok, Facebook…). Desde ahí no se puede crear el acceso directo.',
      inappSteps: ['Toca <b>···</b> y elige <b>Abrir en el navegador</b> (Safari en iPhone, Chrome en Android).', 'O copia el enlace y pégalo en el navegador.', 'Ahí busca <b>Agregar a pantalla de inicio</b>.'],
      amenu: ['Toca el menú <b>⋮</b> del navegador.', 'Elige <b>Instalar app</b> o <b>Agregar a pantalla principal</b>.', 'Confirma. Luego abre Plata Clara desde el nuevo ícono.'],
      prompt: 'Tendrás Plata Clara como una app más: se abre en pantalla completa y funciona sin internet.', pc: 'Abre este enlace en tu celular para tener Plata Clara como app en tu pantalla de inicio.',
      install: 'Instalar app', copy: 'Copiar enlace', copied: 'Enlace copiado. Pégalo en tu navegador.', copiedIos: 'Enlace copiado. Pégalo en Safari.', later: 'Ahora no', close: 'Cerrar', also: 'También lo encuentras luego en Tu cuenta.', account: 'Instalar en este dispositivo' },
    en: { title: 'Put Plata Clara on your Home Screen', why: 'Open it with one tap, like any other app.', whyIos: 'Open it with one tap, like any other app. On iPhone, this is also required to get notifications.',
      safari: ['Tap the <b>Share</b> button {S} in the Safari toolbar. If you don’t see it, tap <b>···</b> first.', 'Scroll down and choose <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. Then open Plata Clara from the new icon.'],
      otro: ['Tap the <b>Share</b> button {S} next to the address bar (or in the <b>···</b> menu).', 'Choose <b>Add to Home Screen</b>.', 'Tap <b>Add</b>. If the option isn’t there, open this link in <b>Safari</b> and repeat the steps.'],
      req: 'On your iPhone version, shortcuts can only be added from <b>Safari</b>. Copy the link, open it in Safari and choose Share → <b>Add to Home Screen</b>.',
      inapp: 'You opened the link inside another app (Instagram, TikTok, Facebook…). You can’t add a shortcut from there.',
      inappSteps: ['Tap <b>···</b> and choose <b>Open in browser</b> (Safari on iPhone, Chrome on Android).', 'Or copy the link and paste it into your browser.', 'Then look for <b>Add to Home Screen</b>.'],
      amenu: ['Tap the browser menu <b>⋮</b>.', 'Choose <b>Install app</b> or <b>Add to Home screen</b>.', 'Confirm. Then open Plata Clara from the new icon.'],
      prompt: 'Plata Clara will work like any other app: it opens full screen and works offline.', pc: 'Open this link on your phone to add Plata Clara to your Home Screen.',
      install: 'Install app', copy: 'Copy link', copied: 'Link copied. Paste it into your browser.', copiedIos: 'Link copied. Paste it into Safari.', later: 'Not now', close: 'Close', also: 'You can also find this later in Your account.', account: 'Install on this device' },
    pt: { title: 'Tenha o Plata Clara na sua tela de início', why: 'Assim você abre com um toque, como qualquer app.', whyIos: 'Assim você abre com um toque, como qualquer app. No iPhone, isso também é necessário para receber notificações.',
      safari: ['Toque no botão <b>Compartilhar</b> {S} na barra do Safari. Se não aparecer, toque primeiro em <b>···</b>.', 'Role para baixo e escolha <b>Adicionar à Tela de Início</b>.', 'Toque em <b>Adicionar</b>. Depois abra o Plata Clara pelo novo ícone.'],
      otro: ['Toque no botão <b>Compartilhar</b> {S} ao lado da barra de endereço (ou no menu <b>···</b>).', 'Escolha <b>Adicionar à Tela de Início</b>.', 'Toque em <b>Adicionar</b>. Se a opção não aparecer, abra este link no <b>Safari</b> e repita os passos.'],
      req: 'Na sua versão do iPhone, o atalho só pode ser criado pelo <b>Safari</b>. Copie o link, abra no Safari e escolha Compartilhar → <b>Adicionar à Tela de Início</b>.',
      inapp: 'Você abriu o link dentro de outro app (Instagram, TikTok, Facebook…). Por lá não é possível criar o atalho.',
      inappSteps: ['Toque em <b>···</b> e escolha <b>Abrir no navegador</b> (Safari no iPhone, Chrome no Android).', 'Ou copie o link e cole no navegador.', 'Lá, procure <b>Adicionar à Tela de Início</b>.'],
      amenu: ['Toque no menu <b>⋮</b> do navegador.', 'Escolha <b>Instalar app</b> ou <b>Adicionar à tela inicial</b>.', 'Confirme. Depois abra o Plata Clara pelo novo ícone.'],
      prompt: 'O Plata Clara vai funcionar como qualquer app: abre em tela cheia e funciona sem internet.', pc: 'Abra este link no seu celular para ter o Plata Clara na tela de início.',
      install: 'Instalar app', copy: 'Copiar link', copied: 'Link copiado. Cole no seu navegador.', copiedIos: 'Link copiado. Cole no Safari.', later: 'Agora não', close: 'Fechar', also: 'Você também encontra isso depois em Sua conta.', account: 'Instalar neste dispositivo' },
    fr: { title: 'Ajoute Plata Clara à ton écran d’accueil', why: 'Tu l’ouvres d’un geste, comme n’importe quelle app.', whyIos: 'Tu l’ouvres d’un geste, comme n’importe quelle app. Sur iPhone, c’est aussi nécessaire pour recevoir les notifications.',
      safari: ['Touche le bouton <b>Partager</b> {S} dans la barre de Safari. Si tu ne le vois pas, touche d’abord <b>···</b>.', 'Fais défiler et choisis <b>Sur l’écran d’accueil</b>.', 'Touche <b>Ajouter</b>. Ouvre ensuite Plata Clara depuis la nouvelle icône.'],
      otro: ['Touche le bouton <b>Partager</b> {S} à côté de la barre d’adresse (ou dans le menu <b>···</b>).', 'Choisis <b>Sur l’écran d’accueil</b>.', 'Touche <b>Ajouter</b>. Si l’option n’apparaît pas, ouvre ce lien dans <b>Safari</b> et recommence.'],
      req: 'Sur ta version d’iPhone, le raccourci ne peut être créé que depuis <b>Safari</b>. Copie le lien, ouvre-le dans Safari et choisis Partager → <b>Sur l’écran d’accueil</b>.',
      inapp: 'Tu as ouvert le lien dans une autre app (Instagram, TikTok, Facebook…). Impossible d’y créer le raccourci.',
      inappSteps: ['Touche <b>···</b> et choisis <b>Ouvrir dans le navigateur</b> (Safari sur iPhone, Chrome sur Android).', 'Ou copie le lien et colle-le dans ton navigateur.', 'Cherche ensuite <b>Sur l’écran d’accueil</b>.'],
      amenu: ['Touche le menu <b>⋮</b> du navigateur.', 'Choisis <b>Installer l’application</b> ou <b>Ajouter à l’écran d’accueil</b>.', 'Confirme. Ouvre ensuite Plata Clara depuis la nouvelle icône.'],
      prompt: 'Plata Clara fonctionnera comme une app : plein écran et même sans internet.', pc: 'Ouvre ce lien sur ton téléphone pour ajouter Plata Clara à ton écran d’accueil.',
      install: 'Installer l’app', copy: 'Copier le lien', copied: 'Lien copié. Colle-le dans ton navigateur.', copiedIos: 'Lien copié. Colle-le dans Safari.', later: 'Plus tard', close: 'Fermer', also: 'Tu le retrouveras aussi dans Ton compte.', account: 'Installer sur cet appareil' },
    de: { title: 'Plata Clara auf deinen Home-Bildschirm', why: 'So öffnest du sie mit einem Tipp, wie jede andere App.', whyIos: 'So öffnest du sie mit einem Tipp, wie jede andere App. Auf dem iPhone ist das auch für Mitteilungen nötig.',
      safari: ['Tippe in der Safari-Leiste auf <b>Teilen</b> {S}. Falls du es nicht siehst, tippe zuerst auf <b>···</b>.', 'Scrolle nach unten und wähle <b>Zum Home-Bildschirm</b>.', 'Tippe auf <b>Hinzufügen</b>. Öffne Plata Clara dann über das neue Symbol.'],
      otro: ['Tippe neben der Adressleiste (oder im Menü <b>···</b>) auf <b>Teilen</b> {S}.', 'Wähle <b>Zum Home-Bildschirm</b>.', 'Tippe auf <b>Hinzufügen</b>. Fehlt die Option, öffne diesen Link in <b>Safari</b> und wiederhole die Schritte.'],
      req: 'Auf deiner iPhone-Version geht das nur in <b>Safari</b>. Kopiere den Link, öffne ihn in Safari und wähle Teilen → <b>Zum Home-Bildschirm</b>.',
      inapp: 'Du hast den Link in einer anderen App geöffnet (Instagram, TikTok, Facebook…). Dort lässt sich keine Verknüpfung anlegen.',
      inappSteps: ['Tippe auf <b>···</b> und wähle <b>Im Browser öffnen</b> (Safari auf dem iPhone, Chrome auf Android).', 'Oder kopiere den Link und füge ihn im Browser ein.', 'Suche dort <b>Zum Home-Bildschirm</b>.'],
      amenu: ['Tippe auf das Browsermenü <b>⋮</b>.', 'Wähle <b>App installieren</b> oder <b>Zum Startbildschirm hinzufügen</b>.', 'Bestätige. Öffne Plata Clara dann über das neue Symbol.'],
      prompt: 'Plata Clara funktioniert dann wie jede App: im Vollbild und auch offline.', pc: 'Öffne diesen Link auf deinem Handy, um Plata Clara auf den Home-Bildschirm zu legen.',
      install: 'App installieren', copy: 'Link kopieren', copied: 'Link kopiert. Füge ihn im Browser ein.', copiedIos: 'Link kopiert. Füge ihn in Safari ein.', later: 'Nicht jetzt', close: 'Schließen', also: 'Du findest das später auch unter Dein Konto.', account: 'Auf diesem Gerät installieren' },
    it: { title: 'Metti Plata Clara nella schermata Home', why: 'Così la apri con un tocco, come qualsiasi app.', whyIos: 'Così la apri con un tocco, come qualsiasi app. Su iPhone serve anche per ricevere le notifiche.',
      safari: ['Tocca il pulsante <b>Condividi</b> {S} nella barra di Safari. Se non lo vedi, tocca prima <b>···</b>.', 'Scorri e scegli <b>Aggiungi alla schermata Home</b>.', 'Tocca <b>Aggiungi</b>. Poi apri Plata Clara dalla nuova icona.'],
      otro: ['Tocca il pulsante <b>Condividi</b> {S} accanto alla barra degli indirizzi (o nel menu <b>···</b>).', 'Scegli <b>Aggiungi alla schermata Home</b>.', 'Tocca <b>Aggiungi</b>. Se l’opzione non c’è, apri questo link in <b>Safari</b> e ripeti i passaggi.'],
      req: 'Sulla tua versione di iPhone il collegamento si crea solo da <b>Safari</b>. Copia il link, aprilo in Safari e scegli Condividi → <b>Aggiungi alla schermata Home</b>.',
      inapp: 'Hai aperto il link dentro un’altra app (Instagram, TikTok, Facebook…). Da lì non si può creare il collegamento.',
      inappSteps: ['Tocca <b>···</b> e scegli <b>Apri nel browser</b> (Safari su iPhone, Chrome su Android).', 'Oppure copia il link e incollalo nel browser.', 'Lì cerca <b>Aggiungi alla schermata Home</b>.'],
      amenu: ['Tocca il menu <b>⋮</b> del browser.', 'Scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>.', 'Conferma. Poi apri Plata Clara dalla nuova icona.'],
      prompt: 'Plata Clara funzionerà come un’app: a schermo intero e anche senza internet.', pc: 'Apri questo link sul telefono per avere Plata Clara nella schermata Home.',
      install: 'Installa app', copy: 'Copia link', copied: 'Link copiato. Incollalo nel browser.', copiedIos: 'Link copiato. Incollalo in Safari.', later: 'Non ora', close: 'Chiudi', also: 'Lo trovi anche più tardi in Il tuo account.', account: 'Installa su questo dispositivo' }
  };
  function IL(k) { var l = (document.documentElement.lang || 'es').slice(0, 2); var d = IT[l] || IT.es; return d[k] != null ? d[k] : IT.es[k]; }
  function instSteps(k) {
    var li = function (a) { return '<ol style="margin:0 0 6px;padding-left:22px;line-height:1.6;font-size:15px">' + a.map(function (x) { return '<li style="margin:4px 0">' + x.replace('{S}', SHARE_ICO) + '</li>'; }).join('') + '</ol>'; };
    if (k === 'ios-safari') return li(IL('safari'));
    if (k === 'ios-otro') return li(IL('otro'));
    if (k === 'ios-safari-req') return '<p>' + IL('req') + '</p>';
    if (k === 'inapp') return '<p>' + IL('inapp') + '</p>' + li(IL('inappSteps'));
    if (k === 'android-menu') return li(IL('amenu'));
    if (k === 'prompt') return '<p>' + IL('prompt') + '</p>';
    return '<p>' + IL('pc') + '</p>';
  }
  function installSheet(auto) {
    var k = instKind();
    if (k === 'ya') return;
    var copy = k === 'inapp' || k === 'ios-safari-req' || k === 'pc';
    show('<h2>' + IL('title') + '</h2>' +
      (k === 'prompt' ? '' : '<p>' + IL(isIOS ? 'whyIos' : 'why') + '</p>') +
      instSteps(k) +
      (k === 'prompt' ? '<button class="pc-b" data-in>' + IL('install') + '</button>' : '') +
      (copy ? '<button class="pc-b" data-cp>' + IL('copy') + '</button><div class="pc-m" data-cm style="min-height:0"></div>' : '') +
      '<button class="pc-b alt" data-x>' + IL(auto ? 'later' : 'close') + '</button>' +
      (auto ? '<div class="pc-m" style="min-height:0;font-size:13px">' + IL('also') + '</div>' : ''), function (o) {
        var bi = o.querySelector('[data-in]'), bc = o.querySelector('[data-cp]');
        if (bi) bi.onclick = function () {
          var e = instEvt; if (!e) { close(); return; }
          instEvt = null; e.prompt();
          (e.userChoice || Promise.resolve({})).then(function (r) { markInst(r && r.outcome === 'accepted' ? 'instalado' : 'rechazado'); close(); });
        };
        if (bc) bc.onclick = function () {
          var url = location.origin + location.pathname, m = o.querySelector('[data-cm]');
          var ok = function () { if (m) { m.className = 'pc-m o'; m.textContent = IL(isIOS ? 'copiedIos' : 'copied'); } };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(ok, function () { if (m) m.textContent = url; });
          else if (m) m.textContent = url;
        };
        o.querySelector('[data-x]').onclick = function () { if (auto) markInst('ahora-no'); close(); };
      });
  }
  function offerInstallOnce() {
    if (ov || document.getElementById('coach') || document.querySelector('dialog[open]') || !user || instOffered()) return;
    var k = instKind(); if (k === 'ya' || k === 'pc') return;
    var S0 = window.__pc && window.__pc.get && window.__pc.get();
    if (!S0 || !S0.tour) return;
    markInst('ofrecido');
    installSheet(true);
  }
  window.__pcInstall = function () { installSheet(false); };
  // Pasos para activarlas a mano (la web no puede abrir los ajustes del telefono directamente).
  function pasosAjustes() {
    if (/android/i.test(navigator.userAgent)) return standalone
      ? 'Para activarlas: Ajustes del teléfono → Apps → Plata Clara → Notificaciones → Activar.'
      : 'Para activarlas: en Chrome, toca ⋮ → Configuración → Configuración de sitios → Notificaciones → permite este sitio. Revisa también Ajustes del teléfono → Apps → Chrome → Notificaciones.';
    if (isIOS) return 'Para activarlas: Ajustes del iPhone → Notificaciones → Plata Clara → Permitir notificaciones.';
    return 'Para activarlas: permite las notificaciones de este sitio en la configuración de tu navegador.';
  }

  /* ---------- aviso pequeño con interruptor (Resumen y Deudas) ---------- */
  var nt = { on: false, busy: false, err: '' };
  function T(k, v) { try { return window.__pc && window.__pc.t ? window.__pc.t(k, v) : k; } catch (e) { return k; } }
  function refreshNotif() {
    if (!VAPID || !user || !pushSupported()) { paintNotif(); return Promise.resolve(); }
    return currentSub().then(function (s) {
      nt.on = !!(s && Notification.permission === 'granted');
    }).catch(function () { nt.on = false; }).then(paintNotif);
  }
  function paintNotif() {
    var el = document.getElementById('notif');
    if (!el) return;
    el.hidden = true; el.innerHTML = ''; return;   // avisos: sin interruptor en la app; se gestionan en el telefono
    var v = window.__pc && window.__pc.view && window.__pc.view();
    if (!VAPID || !user || (v !== 'resumen' && v !== 'deudas')) { el.hidden = true; el.innerHTML = ''; return; }
    var blocked = pushSupported() && Notification.permission === 'denied';
    var needIOS = isIOS && !standalone;
    var unsupported = !pushSupported() || needIOS;
    var sub = unsupported
      ? (needIOS ? T('En iPhone, agrega la app a tu pantalla de inicio y ábrela desde ese ícono para activar los avisos.') : T('Este navegador no permite avisos.'))
      : blocked ? T('Los avisos están bloqueados en este dispositivo. Actívalos en los ajustes del navegador.')
      : nt.err ? nt.err
      : nt.on ? T('Activados: te avisamos 1 día antes y el mismo día de cada cuota.')
      : T('Te avisamos 1 día antes y el mismo día de cada cuota, a las 10:00 a. m.');
    el.hidden = false;
    el.innerHTML =
      '<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9M10 20a2 2 0 0 0 4 0"/></svg></span>' +
      '<span class="tx"><b id="nt-l">' + esc(T('Avisos de cuotas')) + '</b><small' + ((blocked || nt.err) ? ' class="e"' : '') + '>' + esc(sub) + '</small></span>' +
      '<button type="button" class="sw" role="switch" aria-labelledby="nt-l" aria-checked="' + (nt.on ? 'true' : 'false') + '"' + ((unsupported || blocked || nt.busy) ? ' disabled' : '') + '></button>';
    var sw = el.querySelector('.sw');
    if (sw) sw.onclick = toggleNotif;
  }
  function toggleNotif() {
    if (nt.busy || !user) return;
    nt.busy = true; nt.err = ''; paintNotif();
    var job = nt.on ? disablePush() : enablePush();
    Promise.resolve(job).catch(function (e) {
      nt.err = (e && e.message === 'denied') ? T('No diste permiso. Vuelve a intentar y elige “Permitir”.') : T('No se pudo cambiar. Intenta de nuevo.');
    }).then(function () { nt.busy = false; return refreshNotif(); });
  }
  document.addEventListener('pc-render', paintNotif);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && user) refreshNotif(); });

  /* ---------- interfaz ---------- */
  var ov = null;
  function css() {
    if (document.getElementById('pc-cloud-css')) return;
    var s = document.createElement('style'); s.id = 'pc-cloud-css';
    s.textContent =
      '#pc-ov{position:fixed;inset:0;z-index:100;background:rgba(10,20,15,.5);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '#pc-ov .pc-card{background:var(--surface);color:var(--ink);border-radius:18px;box-shadow:var(--shadow);width:100%;max-width:400px;padding:22px;max-height:92vh;overflow:auto;font-family:var(--f-body)}' +
      '#pc-ov h2{font-size:21px;margin:0 0 4px}#pc-ov p{color:var(--muted);margin:0 0 14px;font-size:14px}' +
      '#pc-ov label{display:block;font-size:13px;font-weight:600;margin:10px 0 4px}' +
      '#pc-ov input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);font-size:16px}' +
      '#pc-ov .pc-b{display:block;width:100%;margin-top:14px;padding:12px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);font-weight:600}' +
      '#pc-ov .pc-b.alt{background:var(--surface2);color:var(--ink);border:1px solid var(--line)}#pc-ov .pc-b[disabled]{opacity:.6}' +
      '#pc-ov .pc-l{background:none;border:0;color:var(--accent);padding:6px 0;margin-top:8px;font-size:14px;text-decoration:underline}' +
      '#pc-ov .pc-m{margin-top:10px;font-size:14px;min-height:18px}#pc-ov .pc-m.e{color:var(--exp)}#pc-ov .pc-m.o{color:var(--inc)}' +
      '#pc-ov.gate{z-index:1000;flex-direction:column;gap:18px;overflow:auto;background:radial-gradient(circle at 12% 8%,rgba(255,206,84,.55),transparent 38%),radial-gradient(circle at 92% 92%,rgba(40,220,170,.55),transparent 45%),linear-gradient(160deg,#0A5A43 0%,#0E8A67 55%,#13B98D 100%)}' +
      '#pc-ov .pc-hero{text-align:center;color:#fff;margin-top:auto}' +
      '#pc-ov .pc-logo{width:68px;height:68px;border-radius:22px;background:#fff;color:#0E6B50;font:800 30px/68px var(--f-display);margin:0 auto 12px;box-shadow:0 12px 30px rgba(0,0,0,.28)}' +
      '#pc-ov .pc-name{font:700 32px var(--f-display);letter-spacing:-.01em}' +
      '#pc-ov .pc-tag{opacity:.92;font-size:15.5px;margin-top:3px}' +
      '#pc-ov.gate .pc-card{margin-bottom:auto;--surface:#fff;--surface2:#F3F8F5;--ink:#12201A;--muted:#566860;--line:#D3DED8;--accent:#0E6B50;--accent-ink:#fff;border-radius:24px;box-shadow:0 24px 60px rgba(0,0,0,.35);padding:24px}' +
      '#pc-ov.gate .pc-b{background:linear-gradient(135deg,#0E6B50,#12A37A);box-shadow:0 8px 18px rgba(14,107,80,.35)}\n' +
      '#pc-ov.gate .pc-b.alt{background:var(--surface2);color:var(--ink);box-shadow:none}' +
      '#pc-ov.gate input:focus{outline:2px solid #12A37A;border-color:#12A37A}' +
      '#b-account.on{color:var(--accent)}' +
      '#pc-ov .pc-lg{margin-top:12px}#pc-ov .pc-lg select{width:auto;min-width:160px;padding:7px 10px;font-size:14px;background:rgba(255,255,255,.2);color:#fff;border:1px solid rgba(255,255,255,.45)}#pc-ov .pc-lg option{color:#14231d}' +
      '#pc-ov select{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--surface2);color:var(--ink);font-size:16px}';
    s.textContent +=
      '#pc-ov input:not([type=checkbox]),#pc-ov select{min-height:48px}#pc-ov .pc-b{min-height:48px}#pc-ov .pc-l{min-height:48px;padding:12px 0}' +
      '#pc-ov .pc-legal{display:flex;align-items:center;gap:12px;min-height:48px;margin:12px 0 4px;padding:6px 8px;border-radius:12px;font-size:13px;font-weight:400;line-height:1.45;cursor:pointer}' +
      '#pc-ov .pc-legal input{width:22px;height:22px;min-width:22px;min-height:0;margin:0;padding:0;accent-color:var(--accent)}' +
      '#pc-ov .pc-legal a{color:var(--accent);font-weight:600}' +
      '#pc-ov .pc-legal.err{outline:2px solid var(--exp);background:color-mix(in srgb,var(--exp) 8%,transparent)}' +
      '#pc-ov .pc-m.e,#pc-ov .pc-m.o{padding:10px 12px;border-radius:10px;font-weight:500}' +
      '#pc-ov .pc-m.e{background:color-mix(in srgb,var(--exp) 10%,transparent)}#pc-ov .pc-m.o{background:color-mix(in srgb,var(--inc) 10%,transparent)}' +
      '#pc-ov .pc-b[disabled]{cursor:progress}';
    document.head.appendChild(s);
  }
  function close() { if (ov) { ov.remove(); ov = null; } }
  /* ---- Traducción de la pantalla de registro y acceso ---- */
  var TR = {"en": {"Bienvenido a Plata Clara": "Welcome to Plata Clara", "Anota tus ingresos y gastos, controla tus deudas y cuánto te deben, y cumple tus metas de ahorro. Tus datos quedan guardados en tu cuenta.": "Track your income and spending, manage your debts and what people owe you, and reach your savings goals. Your data is saved in your account.", "Crear mi cuenta": "Create my account", "Tus finanzas, claras y en orden": "Your finances, clear and in order", "Acceso privado": "Private access", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara is private. To use it, first arrange your access with a ", "pago único": "one-time payment", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Once we receive your payment, we will enable your email and you can create your account.", "Gestionar mi acceso": "Get my access", "Pídele el acceso a quien te compartió este enlace.": "Ask for access from whoever shared this link.", "Ya me dieron acceso: crear mi cuenta": "I have access: create my account", "Ya tengo cuenta: ingresar": "I have an account: sign in", "Términos y Condiciones": "Terms and Conditions", "Términos": "Terms", "Política de Privacidad": "Privacy Policy", "Privacidad": "Privacy", " y la ": " and the ", "Recuperar contraseña": "Reset password", "Crear cuenta": "Create account", "Ingresar": "Sign in", "Te enviaremos un enlace a tu correo.": "We will send a link to your email.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Your data is saved in the cloud and you see it on all your devices.", "Nombre": "First name", "Apellido": "Last name", "Género": "Gender", "Elige una opción": "Choose an option", "Femenino": "Female", "Masculino": "Male", "Otro": "Other", "Prefiero no decirlo": "Prefer not to say", "Fecha de nacimiento": "Date of birth", "Correo de tu mamá, papá o tutor": "Email of your mom, dad or guardian", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "You are under 14: we will send them a notice so they can authorize you to use the app. Without their permission you will not be able to enter.", "Correo": "Email", "Usa el mismo correo con el que gestionaste tu acceso.": "Use the same email you used to arrange your access.", "Confirma tu correo": "Confirm your email", "Crea una contraseña para la app": "Create a password for the app", "Contraseña": "Password", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "At least 8 characters. Different from your email password.", "Confirma la contraseña": "Confirm the password", "He leído y acepto los ": "I have read and accept the ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". If I am under 18, my mom, dad or guardian knows I use the app.", "Enviar enlace": "Send link", "Volver": "Back", "Ya tengo cuenta": "I already have an account", "No tengo cuenta": "I don't have an account", "Olvidé mi contraseña": "I forgot my password", "Completa todos tus datos.": "Fill in all your details.", "Los correos no coinciden.": "The emails do not match.", "La contraseña debe tener al menos 8 caracteres.": "The password must have at least 8 characters.", "Las contraseñas no coinciden.": "The passwords do not match.", "Escribe un correo válido de tu mamá, papá o tutor.": "Enter a valid email for your mom, dad or guardian.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "The email of your mom, dad or guardian must be different from yours.", "Debes aceptar los Términos y la Política de Privacidad.": "You must accept the Terms and the Privacy Policy.", "Listo. Revisa tu correo.": "Done. Check your email.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "We sent you an email to confirm your account. When you sign in, we will notify your mom, dad or guardian to authorize.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "We sent you an email. Tap the link to confirm, then sign in.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "That email does not have access yet. First arrange your access with a one-time payment.", "Correo o contraseña incorrectos.": "Incorrect email or password.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "That email already has an account. Sign in with your password.", "La contraseña debe tener al menos 6 caracteres.": "The password must have at least 6 characters.", "Demasiados intentos. Espera unos minutos.": "Too many attempts. Wait a few minutes.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirm your email with the link we sent you and sign in again.", "Sin conexión. Revisa tu internet.": "No connection. Check your internet.", "No se pudo completar. Intenta de nuevo.": "Could not complete. Try again.", "No autorizado": "Not authorized", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Your mom, dad or guardian did not authorize the app, so you cannot enter.", "Cerrar sesión": "Sign out", "Cerrar": "Close", "No se pudo verificar": "Could not verify", "Revisa tu internet e inténtalo de nuevo.": "Check your internet and try again.", "Reintentar": "Retry", "Falta el permiso de tus padres": "Your parents' permission is missing", "Enviamos un aviso a ": "We sent a notice to ", ". Cuando autorice, toca “Ya autorizaron”.": ". When they authorize, tap “They authorized”.", "Ya autorizaron, entrar": "They authorized, enter", "Reenviar el aviso": "Resend the notice", "Todavía no hay respuesta de tus padres.": "No reply from your parents yet.", "Aviso enviado. Revisa que le llegue (también en spam).": "Notice sent. Make sure it arrives (check spam too).", "Espera un par de minutos para reenviar.": "Wait a couple of minutes to resend.", "No se pudo enviar. Intenta de nuevo.": "Could not send. Try again.", "Autorización": "Authorization", "Un momento…": "One moment…", "Enlace no válido": "Invalid link", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "This link expired or was already used. Ask your child to resend the notice from the app.", "¿Autorizas el uso de Plata Clara?": "Do you authorize the use of Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " wants to use Plata Clara, a personal finance app. As they are under 14, we need your permission. Their registration data and the money movements they record will be stored. You can read the ", "Sí, autorizo": "Yes, I authorize", "No autorizo": "I do not authorize", "Listo, autorizado": "Done, authorized", "Respuesta enviada": "Reply sent", "Ya puede entrar a la app.": "They can now enter the app.", "No se permitirá el uso de la app.": "Use of the app will not be allowed.", " Puedes cerrar esta página.": " You can close this page.", "Sin conexión. Intenta de nuevo.": "No connection. Try again.", "Sin conexión": "No connection", "Revisa tu internet y abre el enlace de nuevo.": "Check your internet and open the link again.", "Tu cuenta": "Your account", "Sincronizar ahora": "Sync now", "Cargando…": "Loading…", "Código de invitación (opcional)": "Invitation code (optional)", "Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.": "If you were invited to a household, enter the code: you don't need to pay for access.", "Ese código no es válido o ya venció.": "That code is not valid or has expired."}, "pt": {"Tus finanzas, claras y en orden": "Suas finanças, claras e em ordem", "Acceso privado": "Acesso privado", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "O Plata Clara é de acesso privado. Para usá-lo, primeiro providencie seu acesso com um ", "pago único": "pagamento único", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quando recebermos seu pagamento, liberaremos seu e-mail e você poderá criar sua conta.", "Gestionar mi acceso": "Providenciar meu acesso", "Pídele el acceso a quien te compartió este enlace.": "Peça o acesso a quem compartilhou este link.", "Ya me dieron acceso: crear mi cuenta": "Já tenho acesso: criar minha conta", "Ya tengo cuenta: ingresar": "Já tenho conta: entrar", "Términos y Condiciones": "Termos e Condições", "Términos": "Termos", "Política de Privacidad": "Política de Privacidade", "Privacidad": "Privacidade", " y la ": " e a ", "Recuperar contraseña": "Recuperar senha", "Crear cuenta": "Criar conta", "Ingresar": "Entrar", "Te enviaremos un enlace a tu correo.": "Enviaremos um link para seu e-mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Seus dados ficam salvos na nuvem e você os vê em todos os seus dispositivos.", "Nombre": "Nome", "Apellido": "Sobrenome", "Género": "Gênero", "Elige una opción": "Escolha uma opção", "Femenino": "Feminino", "Masculino": "Masculino", "Otro": "Outro", "Prefiero no decirlo": "Prefiro não dizer", "Fecha de nacimiento": "Data de nascimento", "Correo de tu mamá, papá o tutor": "E-mail da sua mãe, pai ou responsável", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Você tem menos de 14 anos: enviaremos um aviso para que autorize o uso do app. Sem a permissão não será possível entrar.", "Correo": "E-mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Use o mesmo e-mail com o qual providenciou seu acesso.", "Confirma tu correo": "Confirme seu e-mail", "Crea una contraseña para la app": "Crie uma senha para o app", "Contraseña": "Senha", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Mínimo de 8 caracteres. Diferente da senha do seu e-mail.", "Confirma la contraseña": "Confirme a senha", "He leído y acepto los ": "Li e aceito os ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Se tenho menos de 18 anos, minha mãe, pai ou responsável sabe que uso o app.", "Enviar enlace": "Enviar link", "Volver": "Voltar", "Ya tengo cuenta": "Já tenho conta", "No tengo cuenta": "Não tenho conta", "Olvidé mi contraseña": "Esqueci minha senha", "Completa todos tus datos.": "Preencha todos os seus dados.", "Los correos no coinciden.": "Os e-mails não coincidem.", "La contraseña debe tener al menos 8 caracteres.": "A senha deve ter pelo menos 8 caracteres.", "Las contraseñas no coinciden.": "As senhas não coincidem.", "Escribe un correo válido de tu mamá, papá o tutor.": "Digite um e-mail válido da sua mãe, pai ou responsável.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "O e-mail da sua mãe, pai ou responsável deve ser diferente do seu.", "Debes aceptar los Términos y la Política de Privacidad.": "Você deve aceitar os Termos e a Política de Privacidade.", "Listo. Revisa tu correo.": "Pronto. Verifique seu e-mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Enviamos um e-mail para confirmar sua conta. Ao entrar, avisaremos sua mãe, pai ou responsável para autorizar.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Enviamos um e-mail. Toque no link para confirmar e depois entre.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Esse e-mail ainda não tem acesso. Primeiro providencie seu acesso com um pagamento único.", "Correo o contraseña incorrectos.": "E-mail ou senha incorretos.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Esse e-mail já tem conta. Entre com sua senha.", "La contraseña debe tener al menos 6 caracteres.": "A senha deve ter pelo menos 6 caracteres.", "Demasiados intentos. Espera unos minutos.": "Muitas tentativas. Aguarde alguns minutos.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirme seu e-mail pelo link que enviamos e entre novamente.", "Sin conexión. Revisa tu internet.": "Sem conexão. Verifique sua internet.", "No se pudo completar. Intenta de nuevo.": "Não foi possível concluir. Tente novamente.", "No autorizado": "Não autorizado", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Sua mãe, pai ou responsável não autorizou o uso do app, então você não pode entrar.", "Cerrar sesión": "Sair", "Cerrar": "Fechar", "No se pudo verificar": "Não foi possível verificar", "Revisa tu internet e inténtalo de nuevo.": "Verifique sua internet e tente novamente.", "Reintentar": "Tentar novamente", "Falta el permiso de tus padres": "Falta a permissão dos seus pais", "Enviamos un aviso a ": "Enviamos um aviso para ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quando autorizar, toque em “Já autorizaram”.", "Ya autorizaron, entrar": "Já autorizaram, entrar", "Reenviar el aviso": "Reenviar o aviso", "Todavía no hay respuesta de tus padres.": "Ainda não há resposta dos seus pais.", "Aviso enviado. Revisa que le llegue (también en spam).": "Aviso enviado. Verifique se chegou (também no spam).", "Espera un par de minutos para reenviar.": "Aguarde alguns minutos para reenviar.", "No se pudo enviar. Intenta de nuevo.": "Não foi possível enviar. Tente novamente.", "Autorización": "Autorização", "Un momento…": "Um momento…", "Enlace no válido": "Link inválido", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Este link expirou ou já foi usado. Peça ao seu filho(a) que reenvie o aviso pelo app.", "¿Autorizas el uso de Plata Clara?": "Você autoriza o uso do Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " quer usar o Plata Clara, um app de finanças pessoais. Como tem menos de 14 anos, precisamos da sua permissão. Serão guardados seus dados de cadastro e as movimentações de dinheiro que registrar. Você pode ler os ", "Sí, autorizo": "Sim, autorizo", "No autorizo": "Não autorizo", "Listo, autorizado": "Pronto, autorizado", "Respuesta enviada": "Resposta enviada", "Ya puede entrar a la app.": "Já pode entrar no app.", "No se permitirá el uso de la app.": "O uso do app não será permitido.", " Puedes cerrar esta página.": " Você pode fechar esta página.", "Sin conexión. Intenta de nuevo.": "Sem conexão. Tente novamente.", "Sin conexión": "Sem conexão", "Revisa tu internet y abre el enlace de nuevo.": "Verifique sua internet e abra o link novamente.", "Tu cuenta": "Sua conta", "Sincronizar ahora": "Sincronizar agora", "Cargando…": "Carregando…", "Código de invitación (opcional)": "Código de convite (opcional)", "Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.": "Se você foi convidado para uma casa, digite o código: não precisa pagar o acesso.", "Ese código no es válido o ya venció.": "Esse código não é válido ou já venceu."}, "fr": {"Tus finanzas, claras y en orden": "Vos finances, claires et en ordre", "Acceso privado": "Accès privé", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara est en accès privé. Pour l'utiliser, obtenez d'abord votre accès avec un ", "pago único": "paiement unique", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quand nous recevrons votre paiement, nous activerons votre e-mail et vous pourrez créer votre compte.", "Gestionar mi acceso": "Obtenir mon accès", "Pídele el acceso a quien te compartió este enlace.": "Demandez l'accès à la personne qui vous a partagé ce lien.", "Ya me dieron acceso: crear mi cuenta": "J'ai l'accès : créer mon compte", "Ya tengo cuenta: ingresar": "J'ai un compte : me connecter", "Términos y Condiciones": "Conditions générales", "Términos": "Conditions", "Política de Privacidad": "Politique de confidentialité", "Privacidad": "Confidentialité", " y la ": " et la ", "Recuperar contraseña": "Récupérer le mot de passe", "Crear cuenta": "Créer un compte", "Ingresar": "Se connecter", "Te enviaremos un enlace a tu correo.": "Nous vous enverrons un lien par e-mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Vos données sont enregistrées dans le cloud et visibles sur tous vos appareils.", "Nombre": "Prénom", "Apellido": "Nom de famille", "Género": "Genre", "Elige una opción": "Choisissez une option", "Femenino": "Féminin", "Masculino": "Masculin", "Otro": "Autre", "Prefiero no decirlo": "Je préfère ne pas le dire", "Fecha de nacimiento": "Date de naissance", "Correo de tu mamá, papá o tutor": "E-mail de ta mère, ton père ou ton tuteur", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Tu as moins de 14 ans : nous leur enverrons un avis pour qu'ils autorisent ton utilisation de l'app. Sans leur accord, tu ne pourras pas entrer.", "Correo": "E-mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Utilise le même e-mail que pour obtenir ton accès.", "Confirma tu correo": "Confirme ton e-mail", "Crea una contraseña para la app": "Crée un mot de passe pour l'app", "Contraseña": "Mot de passe", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "8 caractères minimum. Différent du mot de passe de ton e-mail.", "Confirma la contraseña": "Confirme le mot de passe", "He leído y acepto los ": "J'ai lu et j'accepte les ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Si j'ai moins de 18 ans, ma mère, mon père ou mon tuteur sait que j'utilise l'app.", "Enviar enlace": "Envoyer le lien", "Volver": "Retour", "Ya tengo cuenta": "J'ai déjà un compte", "No tengo cuenta": "Je n'ai pas de compte", "Olvidé mi contraseña": "J'ai oublié mon mot de passe", "Completa todos tus datos.": "Remplis toutes tes informations.", "Los correos no coinciden.": "Les e-mails ne correspondent pas.", "La contraseña debe tener al menos 8 caracteres.": "Le mot de passe doit contenir au moins 8 caractères.", "Las contraseñas no coinciden.": "Les mots de passe ne correspondent pas.", "Escribe un correo válido de tu mamá, papá o tutor.": "Saisis un e-mail valide de ta mère, ton père ou ton tuteur.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "L'e-mail de ta mère, ton père ou ton tuteur doit être différent du tien.", "Debes aceptar los Términos y la Política de Privacidad.": "Tu dois accepter les Conditions et la Politique de confidentialité.", "Listo. Revisa tu correo.": "C'est fait. Vérifie ton e-mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Nous t'avons envoyé un e-mail pour confirmer ton compte. À ta connexion, nous préviendrons ta mère, ton père ou ton tuteur pour qu'ils autorisent.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Nous t'avons envoyé un e-mail. Touche le lien pour confirmer, puis connecte-toi.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Cet e-mail n'a pas encore accès. Obtiens d'abord ton accès avec un paiement unique.", "Correo o contraseña incorrectos.": "E-mail ou mot de passe incorrect.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Cet e-mail a déjà un compte. Connecte-toi avec ton mot de passe.", "La contraseña debe tener al menos 6 caracteres.": "Le mot de passe doit contenir au moins 6 caractères.", "Demasiados intentos. Espera unos minutos.": "Trop de tentatives. Attends quelques minutes.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Confirme ton e-mail avec le lien que nous t'avons envoyé, puis reconnecte-toi.", "Sin conexión. Revisa tu internet.": "Pas de connexion. Vérifie ton internet.", "No se pudo completar. Intenta de nuevo.": "Impossible de terminer. Réessaie.", "No autorizado": "Non autorisé", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Ta mère, ton père ou ton tuteur n'a pas autorisé l'app, tu ne peux donc pas entrer.", "Cerrar sesión": "Se déconnecter", "Cerrar": "Fermer", "No se pudo verificar": "Vérification impossible", "Revisa tu internet e inténtalo de nuevo.": "Vérifie ton internet et réessaie.", "Reintentar": "Réessayer", "Falta el permiso de tus padres": "L'autorisation de tes parents manque", "Enviamos un aviso a ": "Nous avons envoyé un avis à ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quand ils auront autorisé, touche « Ils ont autorisé ».", "Ya autorizaron, entrar": "Ils ont autorisé, entrer", "Reenviar el aviso": "Renvoyer l'avis", "Todavía no hay respuesta de tus padres.": "Pas encore de réponse de tes parents.", "Aviso enviado. Revisa que le llegue (también en spam).": "Avis envoyé. Vérifie qu'il arrive (aussi dans les spams).", "Espera un par de minutos para reenviar.": "Attends quelques minutes avant de renvoyer.", "No se pudo enviar. Intenta de nuevo.": "Envoi impossible. Réessaie.", "Autorización": "Autorisation", "Un momento…": "Un instant…", "Enlace no válido": "Lien non valide", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Ce lien a expiré ou a déjà été utilisé. Demande à ton enfant de renvoyer l'avis depuis l'app.", "¿Autorizas el uso de Plata Clara?": "Autorises-tu l'utilisation de Plata Clara ?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " veut utiliser Plata Clara, une app de finances personnelles. Ayant moins de 14 ans, nous avons besoin de ton accord. Ses données d'inscription et les mouvements d'argent saisis seront conservés. Tu peux lire les ", "Sí, autorizo": "Oui, j'autorise", "No autorizo": "Je n'autorise pas", "Listo, autorizado": "C'est fait, autorisé", "Respuesta enviada": "Réponse envoyée", "Ya puede entrar a la app.": "Il ou elle peut maintenant entrer dans l'app.", "No se permitirá el uso de la app.": "L'utilisation de l'app ne sera pas autorisée.", " Puedes cerrar esta página.": " Tu peux fermer cette page.", "Sin conexión. Intenta de nuevo.": "Pas de connexion. Réessaie.", "Sin conexión": "Pas de connexion", "Revisa tu internet y abre el enlace de nuevo.": "Vérifie ton internet et ouvre à nouveau le lien.", "Tu cuenta": "Ton compte", "Sincronizar ahora": "Synchroniser maintenant", "Cargando…": "Chargement…", "Código de invitación (opcional)": "Code d'invitation (facultatif)", "Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.": "Si on vous a invité dans un foyer, saisissez le code : vous n'avez pas à payer l'accès.", "Ese código no es válido o ya venció.": "Ce code n'est pas valide ou a expiré."}, "de": {"Tus finanzas, claras y en orden": "Deine Finanzen, klar und in Ordnung", "Acceso privado": "Privater Zugang", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara ist privat. Um es zu nutzen, besorge dir zuerst den Zugang mit einer ", "pago único": "Einmalzahlung", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Sobald deine Zahlung eingegangen ist, schalten wir deine E-Mail frei und du kannst dein Konto erstellen.", "Gestionar mi acceso": "Meinen Zugang besorgen", "Pídele el acceso a quien te compartió este enlace.": "Frage die Person, die dir diesen Link geschickt hat, nach dem Zugang.", "Ya me dieron acceso: crear mi cuenta": "Ich habe Zugang: Konto erstellen", "Ya tengo cuenta: ingresar": "Ich habe ein Konto: anmelden", "Términos y Condiciones": "Nutzungsbedingungen", "Términos": "Bedingungen", "Política de Privacidad": "Datenschutzerklärung", "Privacidad": "Datenschutz", " y la ": " und die ", "Recuperar contraseña": "Passwort zurücksetzen", "Crear cuenta": "Konto erstellen", "Ingresar": "Anmelden", "Te enviaremos un enlace a tu correo.": "Wir senden dir einen Link per E-Mail.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "Deine Daten werden in der Cloud gespeichert und sind auf allen Geräten sichtbar.", "Nombre": "Vorname", "Apellido": "Nachname", "Género": "Geschlecht", "Elige una opción": "Wähle eine Option", "Femenino": "Weiblich", "Masculino": "Männlich", "Otro": "Divers", "Prefiero no decirlo": "Keine Angabe", "Fecha de nacimiento": "Geburtsdatum", "Correo de tu mamá, papá o tutor": "E-Mail deiner Mutter, deines Vaters oder Vormunds", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Du bist unter 14: Wir senden ihnen eine Nachricht, damit sie die Nutzung erlauben. Ohne ihre Erlaubnis kannst du nicht hinein.", "Correo": "E-Mail", "Usa el mismo correo con el que gestionaste tu acceso.": "Verwende dieselbe E-Mail, mit der du den Zugang besorgt hast.", "Confirma tu correo": "Bestätige deine E-Mail", "Crea una contraseña para la app": "Erstelle ein Passwort für die App", "Contraseña": "Passwort", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Mindestens 8 Zeichen. Anders als dein E-Mail-Passwort.", "Confirma la contraseña": "Bestätige das Passwort", "He leído y acepto los ": "Ich akzeptiere die ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Wenn ich unter 18 bin, wissen meine Eltern oder mein Vormund, dass ich die App nutze.", "Enviar enlace": "Link senden", "Volver": "Zurück", "Ya tengo cuenta": "Ich habe schon ein Konto", "No tengo cuenta": "Ich habe kein Konto", "Olvidé mi contraseña": "Passwort vergessen", "Completa todos tus datos.": "Fülle alle Angaben aus.", "Los correos no coinciden.": "Die E-Mails stimmen nicht überein.", "La contraseña debe tener al menos 8 caracteres.": "Das Passwort muss mindestens 8 Zeichen haben.", "Las contraseñas no coinciden.": "Die Passwörter stimmen nicht überein.", "Escribe un correo válido de tu mamá, papá o tutor.": "Gib eine gültige E-Mail deiner Eltern oder deines Vormunds ein.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "Die E-Mail deiner Eltern oder deines Vormunds muss sich von deiner unterscheiden.", "Debes aceptar los Términos y la Política de Privacidad.": "Du musst die Nutzungsbedingungen und die Datenschutzerklärung akzeptieren.", "Listo. Revisa tu correo.": "Fertig. Prüfe deine E-Mail.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Wir haben dir eine E-Mail zur Bestätigung gesendet. Beim Anmelden benachrichtigen wir deine Eltern oder deinen Vormund zur Freigabe.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Wir haben dir eine E-Mail gesendet. Tippe auf den Link zum Bestätigen und melde dich dann an.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Diese E-Mail hat noch keinen Zugang. Besorge dir zuerst den Zugang mit einer Einmalzahlung.", "Correo o contraseña incorrectos.": "E-Mail oder Passwort falsch.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Diese E-Mail hat bereits ein Konto. Melde dich mit deinem Passwort an.", "La contraseña debe tener al menos 6 caracteres.": "Das Passwort muss mindestens 6 Zeichen haben.", "Demasiados intentos. Espera unos minutos.": "Zu viele Versuche. Warte ein paar Minuten.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Bestätige deine E-Mail mit dem Link, den wir dir geschickt haben, und melde dich erneut an.", "Sin conexión. Revisa tu internet.": "Keine Verbindung. Prüfe dein Internet.", "No se pudo completar. Intenta de nuevo.": "Fehlgeschlagen. Versuche es erneut.", "No autorizado": "Nicht genehmigt", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Deine Eltern oder dein Vormund haben die Nutzung nicht erlaubt, daher kannst du nicht hinein.", "Cerrar sesión": "Abmelden", "Cerrar": "Schließen", "No se pudo verificar": "Überprüfung fehlgeschlagen", "Revisa tu internet e inténtalo de nuevo.": "Prüfe dein Internet und versuche es erneut.", "Reintentar": "Erneut versuchen", "Falta el permiso de tus padres": "Die Erlaubnis deiner Eltern fehlt", "Enviamos un aviso a ": "Wir haben eine Nachricht gesendet an ", ". Cuando autorice, toca “Ya autorizaron”.": ". Wenn sie erlaubt haben, tippe auf „Sie haben erlaubt“.", "Ya autorizaron, entrar": "Sie haben erlaubt, hinein", "Reenviar el aviso": "Nachricht erneut senden", "Todavía no hay respuesta de tus padres.": "Noch keine Antwort deiner Eltern.", "Aviso enviado. Revisa que le llegue (también en spam).": "Nachricht gesendet. Prüfe, ob sie ankommt (auch im Spam).", "Espera un par de minutos para reenviar.": "Warte ein paar Minuten, bevor du erneut sendest.", "No se pudo enviar. Intenta de nuevo.": "Senden fehlgeschlagen. Versuche es erneut.", "Autorización": "Genehmigung", "Un momento…": "Einen Moment…", "Enlace no válido": "Ungültiger Link", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Dieser Link ist abgelaufen oder wurde bereits verwendet. Bitte dein Kind, die Nachricht in der App erneut zu senden.", "¿Autorizas el uso de Plata Clara?": "Erlaubst du die Nutzung von Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " möchte Plata Clara, eine App für persönliche Finanzen, nutzen. Da er/sie unter 14 ist, brauchen wir deine Erlaubnis. Registrierungsdaten und erfasste Geldbewegungen werden gespeichert. Lies auch die ", "Sí, autorizo": "Ja, ich erlaube", "No autorizo": "Ich erlaube nicht", "Listo, autorizado": "Fertig, erlaubt", "Respuesta enviada": "Antwort gesendet", "Ya puede entrar a la app.": "Er oder sie kann jetzt in die App.", "No se permitirá el uso de la app.": "Die Nutzung der App wird nicht erlaubt.", " Puedes cerrar esta página.": " Du kannst diese Seite schließen.", "Sin conexión. Intenta de nuevo.": "Keine Verbindung. Versuche es erneut.", "Sin conexión": "Keine Verbindung", "Revisa tu internet y abre el enlace de nuevo.": "Prüfe dein Internet und öffne den Link erneut.", "Tu cuenta": "Dein Konto", "Sincronizar ahora": "Jetzt synchronisieren", "Cargando…": "Lädt…", "Código de invitación (opcional)": "Einladungscode (optional)", "Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.": "Wenn du in einen Haushalt eingeladen wurdest, gib den Code ein: Du musst den Zugang nicht bezahlen.", "Ese código no es válido o ya venció.": "Dieser Code ist ungültig oder abgelaufen."}, "it": {"Tus finanzas, claras y en orden": "Le tue finanze, chiare e in ordine", "Acceso privado": "Accesso privato", "Plata Clara es de acceso privado. Para usarla, primero gestiona tu acceso con un ": "Plata Clara è ad accesso privato. Per usarla, prima gestisci il tuo accesso con un ", "pago único": "pagamento unico", ". Cuando recibamos tu pago te daremos permiso con tu correo y podrás crear tu cuenta.": ". Quando riceveremo il pagamento, abiliteremo la tua email e potrai creare il tuo account.", "Gestionar mi acceso": "Gestisci il mio accesso", "Pídele el acceso a quien te compartió este enlace.": "Chiedi l'accesso a chi ti ha condiviso questo link.", "Ya me dieron acceso: crear mi cuenta": "Ho l'accesso: crea il mio account", "Ya tengo cuenta: ingresar": "Ho un account: accedi", "Términos y Condiciones": "Termini e Condizioni", "Términos": "Termini", "Política de Privacidad": "Informativa sulla privacy", "Privacidad": "Privacy", " y la ": " e l'", "Recuperar contraseña": "Recupera la password", "Crear cuenta": "Crea account", "Ingresar": "Accedi", "Te enviaremos un enlace a tu correo.": "Ti invieremo un link via email.", "Tus datos se guardan en la nube y los ves en todos tus dispositivos.": "I tuoi dati sono salvati nel cloud e li vedi su tutti i tuoi dispositivi.", "Nombre": "Nome", "Apellido": "Cognome", "Género": "Genere", "Elige una opción": "Scegli un'opzione", "Femenino": "Femminile", "Masculino": "Maschile", "Otro": "Altro", "Prefiero no decirlo": "Preferisco non dirlo", "Fecha de nacimiento": "Data di nascita", "Correo de tu mamá, papá o tutor": "Email di tua madre, tuo padre o tutore", "Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.": "Hai meno di 14 anni: invieremo loro un avviso per autorizzarti a usare l'app. Senza il loro permesso non potrai entrare.", "Correo": "Email", "Usa el mismo correo con el que gestionaste tu acceso.": "Usa la stessa email con cui hai gestito il tuo accesso.", "Confirma tu correo": "Conferma la tua email", "Crea una contraseña para la app": "Crea una password per l'app", "Contraseña": "Password", "Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.": "Minimo 8 caratteri. Diversa dalla password della tua email.", "Confirma la contraseña": "Conferma la password", "He leído y acepto los ": "Ho letto e accetto i ", ". Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.": ". Se ho meno di 18 anni, mia madre, mio padre o il mio tutore sa che uso l'app.", "Enviar enlace": "Invia link", "Volver": "Indietro", "Ya tengo cuenta": "Ho già un account", "No tengo cuenta": "Non ho un account", "Olvidé mi contraseña": "Ho dimenticato la password", "Completa todos tus datos.": "Compila tutti i tuoi dati.", "Los correos no coinciden.": "Le email non coincidono.", "La contraseña debe tener al menos 8 caracteres.": "La password deve avere almeno 8 caratteri.", "Las contraseñas no coinciden.": "Le password non coincidono.", "Escribe un correo válido de tu mamá, papá o tutor.": "Inserisci un'email valida di tua madre, tuo padre o tutore.", "El correo de tu mamá, papá o tutor debe ser distinto al tuyo.": "L'email di tua madre, tuo padre o tutore deve essere diversa dalla tua.", "Debes aceptar los Términos y la Política de Privacidad.": "Devi accettare i Termini e l'Informativa sulla privacy.", "Listo. Revisa tu correo.": "Fatto. Controlla la tua email.", "Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.": "Ti abbiamo inviato un'email per confermare l'account. Quando accedi, avviseremo tua madre, tuo padre o tutore per l'autorizzazione.", "Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.": "Ti abbiamo inviato un'email. Tocca il link per confermare e poi accedi.", "Ese correo todavía no tiene acceso. Primero gestiona tu acceso con un pago único.": "Questa email non ha ancora accesso. Prima gestisci l'accesso con un pagamento unico.", "Correo o contraseña incorrectos.": "Email o password errati.", "Ese correo ya tiene cuenta. Ingresa con tu contraseña.": "Questa email ha già un account. Accedi con la tua password.", "La contraseña debe tener al menos 6 caracteres.": "La password deve avere almeno 6 caratteri.", "Demasiados intentos. Espera unos minutos.": "Troppi tentativi. Attendi qualche minuto.", "Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.": "Conferma la tua email con il link che ti abbiamo inviato e accedi di nuovo.", "Sin conexión. Revisa tu internet.": "Nessuna connessione. Controlla internet.", "No se pudo completar. Intenta de nuevo.": "Impossibile completare. Riprova.", "No autorizado": "Non autorizzato", "Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.": "Tua madre, tuo padre o tutore non ha autorizzato l'app, quindi non puoi entrare.", "Cerrar sesión": "Esci", "Cerrar": "Chiudi", "No se pudo verificar": "Impossibile verificare", "Revisa tu internet e inténtalo de nuevo.": "Controlla internet e riprova.", "Reintentar": "Riprova", "Falta el permiso de tus padres": "Manca il permesso dei tuoi genitori", "Enviamos un aviso a ": "Abbiamo inviato un avviso a ", ". Cuando autorice, toca “Ya autorizaron”.": ". Quando autorizzano, tocca “Hanno autorizzato”.", "Ya autorizaron, entrar": "Hanno autorizzato, entra", "Reenviar el aviso": "Reinvia l'avviso", "Todavía no hay respuesta de tus padres.": "Nessuna risposta dai tuoi genitori.", "Aviso enviado. Revisa que le llegue (también en spam).": "Avviso inviato. Controlla che arrivi (anche nello spam).", "Espera un par de minutos para reenviar.": "Attendi un paio di minuti per reinviare.", "No se pudo enviar. Intenta de nuevo.": "Invio non riuscito. Riprova.", "Autorización": "Autorizzazione", "Un momento…": "Un momento…", "Enlace no válido": "Link non valido", "Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.": "Questo link è scaduto o è già stato usato. Chiedi a tuo figlio/a di reinviare l'avviso dall'app.", "¿Autorizas el uso de Plata Clara?": "Autorizzi l'uso di Plata Clara?", " quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los ": " vuole usare Plata Clara, un'app di finanze personali. Avendo meno di 14 anni, serve il tuo permesso. Verranno salvati i dati di registrazione e i movimenti di denaro inseriti. Puoi leggere i ", "Sí, autorizo": "Sì, autorizzo", "No autorizo": "Non autorizzo", "Listo, autorizado": "Fatto, autorizzato", "Respuesta enviada": "Risposta inviata", "Ya puede entrar a la app.": "Ora può entrare nell'app.", "No se permitirá el uso de la app.": "L'uso dell'app non sarà consentito.", " Puedes cerrar esta página.": " Puoi chiudere questa pagina.", "Sin conexión. Intenta de nuevo.": "Nessuna connessione. Riprova.", "Sin conexión": "Nessuna connessione", "Revisa tu internet y abre el enlace de nuevo.": "Controlla internet e riapri il link.", "Tu cuenta": "Il tuo account", "Sincronizar ahora": "Sincronizza ora", "Cargando…": "Caricamento…", "Código de invitación (opcional)": "Codice di invito (facoltativo)", "Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.": "Se sei stato invitato in una famiglia, inserisci il codice: non devi pagare l'accesso.", "Ese código no es válido o ya venció.": "Questo codice non è valido o è scaduto."}}, TR_RE = {};
  function tr(s) {
    var l = (document.documentElement.lang || 'es').slice(0, 2), d = TR[l];
    if (!d || typeof s !== 'string') return s;
    if (!TR_RE[l]) TR_RE[l] = new RegExp(Object.keys(d).sort(function (a, b) { return b.length - a.length; }).map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|'), 'g');
    return s.replace(TR_RE[l], function (m) { return d[m]; });
  }
  function langPick() {
    var P = window.__pc, L = (P && P.langs) || [], cur = (document.documentElement.lang || 'es').slice(0, 2);
    if (!L.length) return '';
    return '<div class="pc-lg"><select id="pc-lg" aria-label="Idioma / Language">' + L.map(function (x) { return '<option value="' + x.c + '"' + (x.c === cur ? ' selected' : '') + '>' + x.n + '</option>'; }).join('') + '</select></div>';
  }
  function show(html, bind, sticky) {
    css(); close();
    var orig = html; html = tr(html);
    var gate = !user || !!sticky;
    ov = document.createElement('div'); ov.id = 'pc-ov'; if (gate) ov.className = 'gate pc-entry';
    ov.innerHTML = (gate ? '<div class="pc-hero"><div class="pc-logo"><img src="icon.svg" alt="" width="72" height="72"></div><div class="pc-name">Plata Clara</div><div class="pc-tag">' + tr('Tus finanzas, claras y en orden') + '</div>' + langPick() + '<div class="pc-auth-art" aria-hidden="true"><i></i><i></i><i></i></div></div>' : '') +
      '<div class="pc-card pc-auth-card" role="dialog" aria-modal="true" aria-label="Plata Clara">' + html + '</div>';
    if (!gate) ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.body.appendChild(ov);
    if (bind) bind(ov);
    var lg = ov.querySelector('#pc-lg');
    if (lg) lg.onchange = function () { if (window.__pc && window.__pc.setLang) { window.__pc.setLang(lg.value); show(orig, bind, sticky); } };
    var f = ov.querySelector('input'); if (f) f.focus();
  }
  function msg(t, kind) { var m = ov && (ov.querySelector('.pc-m[role="status"]') || ov.querySelector('.pc-m')); if (m) { m.textContent = tr(t); m.className = 'pc-m ' + (kind || ''); } }
  function hogaresOn() { return !!(window.PC_FLAGS && window.PC_FLAGS.households === true); }
  function friendly(e) {
    var m = (e && e.message || '').toLowerCase();
    if (m.indexOf('codigo_invalido') > -1) return 'Ese código no es válido o ya venció.';
    if (m.indexOf('database error saving new user') > -1 || m.indexOf('sin_acceso') > -1) return 'Este correo aún no tiene acceso a la beta privada. Pide acceso a Plata Clara.';
    if (m.indexOf('sending confirmation') > -1 || m.indexOf('not authorized') > -1 || m.indexOf('sending recovery') > -1) return 'No pudimos enviar el correo. Escríbenos para activar tu cuenta.';
        if (m.indexOf('invalid login') > -1) return 'Correo o contraseña incorrectos.';
    if (m.indexOf('already registered') > -1) return 'Ese correo ya tiene cuenta. Ingresa con tu contraseña.';
    if (m.indexOf('password') > -1 && m.indexOf('6') > -1) return 'La contraseña debe tener al menos 6 caracteres.';
    if (m.indexOf('rate limit') > -1 || m.indexOf('too many') > -1) return 'Demasiados intentos. Espera unos minutos.';
    if (m.indexOf('email not confirmed') > -1) return 'Confirma tu correo con el enlace que te enviamos y vuelve a ingresar.';
    if (m.indexOf('fetch') > -1 || m.indexOf('network') > -1) return 'Sin conexión. Revisa tu internet.';
    return 'No se pudo completar. Intenta de nuevo.';
  }

  function age(s) {
    var p = String(s || '').split('-'); if (p.length !== 3) return null;
    var n = new Date(), a = n.getFullYear() - (+p[0]), m = n.getMonth() + 1 - (+p[1]);
    if (m < 0 || (m === 0 && n.getDate() < (+p[2]))) a--;
    return isFinite(a) ? a : null;
  }
  var MAILRE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function maskMail(e) { var p = String(e || '').split('@'); return p.length === 2 ? p[0].slice(0, 2) + '***@' + p[1] : ''; }
  function callConsent(body, jwt) {
    return fetch(C.SUPABASE_URL + '/functions/v1/parent-consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: C.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + (jwt || C.SUPABASE_ANON_KEY) },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  /* ---------- permiso de padres (menores de 14) ---------- */
  function checkConsent(silent) {
    if (!user || !sb) return Promise.resolve(false);
    return sb.from('profiles').select('consent_status,parent_email,consent_sent_at').eq('user_id', user.id).maybeSingle().then(function (r) {
      if (r.error) {
        var code = String(r.error.code || '') + String(r.error.message || '');
        if (/PGRST205|42P01|does not exist/.test(code) || getMark().uid === user.id) { consentOK = true; return true; }
        if (!silent) waitSheet('error');
        return false;
      }
      var p = r.data, s = p && p.consent_status;
      if (s === 'pending' || s === 'rejected') {
        consentOK = false;
        if (!silent) {
          if (s === 'pending' && !p.consent_sent_at) {
            sb.auth.getSession().then(function (x) { return callConsent({ action: 'request' }, x.data.session && x.data.session.access_token); }).catch(function () {});
          }
          waitSheet(s, p);
        }
        return false;
      }
      consentOK = true; return true;     // adulto/14+, aprobado o cuenta anterior sin perfil
    }, function () { if (getMark().uid === user.id) { consentOK = true; return true; } return false; });
  }
  function waitSheet(s, p) {
    lock();
    var out = function (o) {
      var b = o.querySelector('[data-o]');
      if (b) b.onclick = function () { consentOK = false; sb.auth.signOut().then(function () { wipeLocal(); }); };
    };
    if (s === 'rejected') {
      show('<h2>No autorizado</h2><p>Tu mamá, papá o tutor no autorizó el uso de la app, así que no puedes entrar.</p><button class="pc-b alt" data-o>Cerrar sesión</button>', out, true);
      return;
    }
    if (s === 'error') {
      show('<h2>No se pudo verificar</h2><p>Revisa tu internet e inténtalo de nuevo.</p><div class="pc-m"></div><button class="pc-b" data-r>Reintentar</button><button class="pc-l" data-o>Cerrar sesión</button>', function (o) {
        out(o); o.querySelector('[data-r]').onclick = function () { entering = null; enter(); };
      }, true);
      return;
    }
    show('<h2>Falta el permiso de tus padres</h2><p>Enviamos un aviso a <b>' + esc(maskMail(p && p.parent_email)) + '</b>. Cuando autorice, toca “Ya autorizaron”.</p><div class="pc-m" role="status"></div>' +
      '<button class="pc-b" data-r>Ya autorizaron, entrar</button><button class="pc-b alt" data-s>Reenviar el aviso</button><button class="pc-l" data-o>Cerrar sesión</button>', function (o) {
      out(o);
      o.querySelector('[data-r]').onclick = function () {
        checkConsent(true).then(function (ok) { if (ok) { paint(); reconcile(); refreshPushTz(); } else msg('Todavía no hay respuesta de tus padres.', 'e'); });
      };
      o.querySelector('[data-s]').onclick = function () {
        sb.auth.getSession().then(function (x) { return callConsent({ action: 'request', force: true }, x.data.session && x.data.session.access_token); })
          .then(function (j) { if (j && j.ok) msg('Aviso enviado. Revisa que le llegue (también en spam).', 'o'); else if (j && j.error === 'wait') msg('Espera un par de minutos para reenviar.', 'e'); else msg('No se pudo enviar. Intenta de nuevo.', 'e'); })
          .catch(function () { msg('Sin conexión. Revisa tu internet.', 'e'); });
      };
    }, true);
  }
  /* Pantalla que ve el padre/madre al abrir el enlace del correo (no necesita cuenta) */
  function consentSheet(token) {
    show('<h2>Autorización</h2><p>Un momento…</p>');
    fetch(C.SUPABASE_URL + '/functions/v1/parent-consent?token=' + encodeURIComponent(token), { headers: { apikey: C.SUPABASE_ANON_KEY } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { show('<h2>Enlace no válido</h2><p>Este enlace venció o ya se usó. Pídele a tu hijo/a que reenvíe el aviso desde la app.</p>'); return; }
        show('<h2>¿Autorizas el uso de Plata Clara?</h2><p><b>' + esc(j.nombre) + '</b> quiere usar Plata Clara, una app de finanzas personales. Como tiene menos de 14 años, necesitamos tu permiso. Se guardarán sus datos de registro y los movimientos de dinero que anote. Puedes leer los <a href="terminos.html" target="_blank" rel="noopener">Términos</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>.</p>' +
          '<button class="pc-b" data-d="approve">Sí, autorizo</button><button class="pc-b alt" data-d="reject">No autorizo</button><div class="pc-m" role="status"></div>', function (o) {
          o.querySelectorAll('[data-d]').forEach(function (b) {
            b.onclick = function () {
              o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = true; });
              var ok = b.getAttribute('data-d') === 'approve';
              callConsent({ action: 'decide', token: token, decision: b.getAttribute('data-d') }).then(function (r) {
                if (r && r.ok) show('<h2>' + (ok ? 'Listo, autorizado' : 'Respuesta enviada') + '</h2><p>' + (ok ? 'Ya puede entrar a la app.' : 'No se permitirá el uso de la app.') + ' Puedes cerrar esta página.</p>');
                else { msg('No se pudo enviar. Intenta de nuevo.', 'e'); o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = false; }); }
              }).catch(function () { msg('Sin conexión. Intenta de nuevo.', 'e'); o.querySelectorAll('[data-d]').forEach(function (x) { x.disabled = false; }); });
            };
          });
        });
      })
      .catch(function () { show('<h2>Sin conexión</h2><p>Revisa tu internet y abre el enlace de nuevo.</p>'); });
  }

  /* Pantalla de entrada: bienvenida, registro libre */
  function accessSheet() {
    show('<h2>Bienvenido a Plata Clara</h2><p>Anota tus ingresos y gastos, controla tus deudas y cuánto te deben, y cumple tus metas de ahorro. Tus datos quedan guardados en tu cuenta.</p>' +
      '<button class="pc-b" data-m="register">Crear mi cuenta</button>' +
      '<button class="pc-b alt" data-m="login">Ya tengo cuenta: ingresar</button>' +
      '<p class="pc-m" style="min-height:0;margin-top:10px"><a href="terminos.html" target="_blank" rel="noopener">Términos</a> · <a href="privacidad.html" target="_blank" rel="noopener">Privacidad</a></p>',
      function (o) { o.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { authSheet(b.getAttribute('data-m')); }; }); });
  }

  function authSheet(mode) {
    var reg = mode === 'register', reset = mode === 'reset', today = new Date().toISOString().slice(0, 10);
    var personal = reg ?
      '<label for="pc-n">Nombre</label><input id="pc-n" maxlength="40" autocomplete="given-name" required>' +
      '<label for="pc-a">Apellido</label><input id="pc-a" maxlength="40" autocomplete="family-name" required>' +
      '<label for="pc-g">Género</label><select id="pc-g" required><option value="">Elige una opción</option><option value="F">Femenino</option><option value="M">Masculino</option><option value="O">Otro</option><option value="N">Prefiero no decirlo</option></select>' +
      '<label for="pc-d">Fecha de nacimiento</label><input id="pc-d" type="date" min="1900-01-01" max="' + today + '" required>' +
      '<div id="pc-par" hidden><label for="pc-pe">Correo de tu mamá, papá o tutor</label><input id="pc-pe" type="email" autocomplete="off"><div class="pc-m" style="min-height:0">Tienes menos de 14 años: le enviaremos un aviso para que autorice que uses la app. Sin su permiso no podrás entrar.</div></div>' : '';
    show(
      '<h2>' + (reset ? 'Recuperar contraseña' : reg ? 'Crear cuenta' : 'Ingresar') + '</h2>' +
      '<p>' + (reset ? 'Te enviaremos un enlace a tu correo.' : 'Tus datos se guardan en la nube y los ves en todos tus dispositivos.') + '</p>' +
      '<form id="pc-f">' + personal +
      '<label for="pc-e">Correo</label><input id="pc-e" type="email" autocomplete="email" required>' +
            (reg ? '<label for="pc-e2">Confirma tu correo</label><input id="pc-e2" type="email" autocomplete="off" required>' : '') +
      (reg && hogaresOn() ? '<label for="pc-ic">Código de invitación (opcional)</label><input id="pc-ic" maxlength="20" autocomplete="off" placeholder="XXXX-XXXX-XXXX"><div class="pc-m" style="min-height:0">Si te invitaron a un hogar, escribe el código: no necesitas pagar el acceso.</div>' : '') +
      (reset ? '' : '<label for="pc-p">' + (reg ? 'Crea una contraseña para la app' : 'Contraseña') + '</label><input id="pc-p" type="password" minlength="' + (reg ? 8 : 6) + '" autocomplete="' + (reg ? 'new-password' : 'current-password') + '" required>') +
      (reg ? '<div class="pc-m" style="min-height:0;margin-top:4px">Mínimo 8 caracteres. Que sea distinta a la contraseña de tu correo.</div><label for="pc-p2">Confirma la contraseña</label><input id="pc-p2" type="password" autocomplete="new-password" required>' : '') +
      (reg ? '<label class="pc-legal" for="pc-t"><input id="pc-t" type="checkbox"><span>He leído y acepto los <a href="terminos.html" target="_blank" rel="noopener">Términos y Condiciones</a> y la <a href="privacidad.html" target="_blank" rel="noopener">Política de Privacidad</a>. Si tengo menos de 18 años, mi mamá, papá o tutor sabe que uso la app.</span></label>' : '') +
      '<button class="pc-b" type="submit">' + (reset ? 'Enviar enlace' : reg ? 'Crear cuenta' : 'Ingresar') + '</button></form>' +
      '<div class="pc-m" role="status"></div>' +
      (reset ? '<button class="pc-l" data-m="login">Volver</button>' :
        '<button class="pc-l" data-m="' + (reg ? 'login' : 'access') + '">' + (reg ? 'Ya tengo cuenta' : 'No tengo cuenta') + '</button>' +
        (reg ? '' : '<br><button class="pc-l" data-m="reset">Olvidé mi contraseña</button>')) +
      '',
      function (o) {
        o.querySelectorAll('[data-m]').forEach(function (b) { b.onclick = function () { var m = b.getAttribute('data-m'); if (m === 'access') accessSheet(); else authSheet(m); }; });
        var tc = o.querySelector('#pc-t');
        if (tc) tc.onchange = function () { var lg = o.querySelector('.pc-legal'); if (lg && tc.checked) lg.classList.remove('err'); };
        o.querySelectorAll('.pc-legal a').forEach(function (a) { a.onclick = function (ev) { ev.stopPropagation(); }; });
        var dI = o.querySelector('#pc-d');
        if (dI) { var tog = function () { var a = age(dI.value), par = o.querySelector('#pc-par'), pe = o.querySelector('#pc-pe'); var minor = a != null && a >= 0 && a < 14; par.hidden = !minor; pe.required = minor; }; dI.onchange = tog; dI.oninput = tog; }
        var val = function (id) { var x = o.querySelector(id); return x ? x.value.trim() : ''; };
        var icode = function () { return val('#pc-ic').replace(/[^A-Za-z0-9]/g, '').toUpperCase(); };
        o.querySelector('#pc-f').onsubmit = function (ev) {
          ev.preventDefault(); ev.stopPropagation();   // que el manejador global de la app no lo tome como suyo
          var email = val('#pc-e'), pw = (o.querySelector('#pc-p') || {}).value, go = o.querySelector('.pc-b'), meta = null, minor = false, bad = '';
          if (reg) {
            var nm = val('#pc-n'), ap = val('#pc-a'), ge = val('#pc-g'), fd = val('#pc-d'), ag = age(fd), pe = val('#pc-pe');
            minor = ag != null && ag < 14;
            if (!nm || !ap || !ge || !fd || ag == null || ag < 0 || ag > 120) bad = 'Completa todos tus datos.';
            else if (email.toLowerCase() !== val('#pc-e2').toLowerCase()) bad = 'Los correos no coinciden.';
            else if (!pw || pw.length < 8) bad = 'La contraseña debe tener al menos 8 caracteres.';
            else if (pw !== o.querySelector('#pc-p2').value) bad = 'Las contraseñas no coinciden.';
            else if (minor && !MAILRE.test(pe)) bad = 'Escribe un correo válido de tu mamá, papá o tutor.';
            else if (minor && pe.toLowerCase() === email.toLowerCase()) bad = 'El correo de tu mamá, papá o tutor debe ser distinto al tuyo.';
            else if (!o.querySelector('#pc-t').checked) bad = 'Debes aceptar los Términos y la Política de Privacidad.';
            meta = { nombre: nm, apellido: ap, genero: ge, fecha_nacimiento: fd, terms_version: '2026-10-22', invite_code: (hogaresOn() && icode()) || undefined };
            if (minor) meta.parent_email = pe;
          }
          var lg = o.querySelector('.pc-legal');
          if (lg) lg.classList.toggle('err', reg && !o.querySelector('#pc-t').checked && bad.indexOf('Términos') > -1);
          if (bad) { msg(bad, 'e'); return; }
          go.disabled = true; msg('Un momento…');
          client().then(function () {
            if (reset) return sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) { if (r.error) throw r.error; msg('Listo. Revisa tu correo.', 'o'); });
            if (reg) return (icode() ? sb.rpc('can_register_invite', { p_email: email, p_code: icode() }) : Promise.resolve({ data: true })).then(function (g) {
              if (g.error) throw g.error;
              if (g.data !== true) throw new Error('codigo_invalido');
              return sb.auth.signUp({ email: email, password: pw, options: { data: meta, emailRedirectTo: location.origin + location.pathname } });
            }).then(function (r) {
              if (r.error) throw r.error;
              if (!r.data.session) { msg(minor ? 'Te enviamos un correo para confirmar tu cuenta. Al entrar, avisaremos a tu mamá, papá o tutor para que autorice.' : 'Te enviamos un correo. Toca el enlace para confirmar y luego ingresa.', 'o'); }
            });
            return sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) { if (r.error) throw r.error; });
          }).catch(function (e) { msg(friendly(e), 'e'); }).then(function () { go.disabled = false; });
        };
      });
  }

  function chooseSheet(row) {
    var cnt = function (d) { return ((d.moves || []).length) + ' movimientos'; };
    show(
      '<h2>Ya tienes datos en la nube</h2>' +
      '<p>Este dispositivo también tiene datos (' + cnt(st()) + '). La nube tiene ' + cnt(row.data) + '. ¿Cuáles quieres conservar?</p>' +
      '<button class="pc-b" data-c="cloud">Usar los de la nube</button>' +
      '<button class="pc-b alt" data-c="local">Subir los de este dispositivo</button>' +
      '<div class="pc-m">Lo que no elijas se reemplaza. Si dudas, usa los de la nube.</div>',
      function (o) {
        o.querySelectorAll('[data-c]').forEach(function (b) {
          b.onclick = function () {
            var c = b.getAttribute('data-c'); close();
            if (c === 'cloud') applyRemote(row); else pushNow(true);
          };
        });
      });
  }

  /* Fase A: la nube cambió (otro dispositivo) y aquí hay cambios sin subir. Sin fusión todavía: se muestra qué se perdería y decide la persona. */
  function conflictSheet(row) {
    setStatus('conflict');
    var loc = st() || {}, rem = row.data || {};
    var ids = function (d) { var o = {}; (d.moves || []).forEach(function (m) { o[m.id] = m; }); return o; };
    var li = ids(loc), ri = ids(rem);
    var soloAqui = Object.keys(li).filter(function (k) { return !ri[k]; }).map(function (k) { return li[k]; });
    var soloNube = Object.keys(ri).filter(function (k) { return !li[k]; }).map(function (k) { return ri[k]; });
    var lista = function (a) { return a.length ? '<ul style="margin:4px 0 10px;padding-left:20px">' + a.slice(0, 3).map(function (m) { return '<li>' + esc(m.desc || m.cat || m.type) + '</li>'; }).join('') + (a.length > 3 ? '<li>y ' + (a.length - 3) + ' más</li>' : '') + '</ul>' : '<p style="margin:4px 0 10px">Ninguno (pueden ser ediciones o borrados).</p>'; };
    show(
      '<h2>Hay cambios en otro dispositivo</h2>' +
      '<p>Tu cuenta recibió cambios desde una versión anterior de la app sin historial de edición compatible. Revisa qué versión conservar antes de continuar.</p>' +
      '<p style="margin:10px 0 0"><b>Solo en este dispositivo (' + soloAqui.length + '):</b></p>' + lista(soloAqui) +
      '<p style="margin:0"><b>Solo en tu cuenta (' + soloNube.length + '):</b></p>' + lista(soloNube) +
      '<button class="pc-b" data-c="local">Conservar los de este dispositivo</button>' +
      '<button class="pc-b alt" data-c="cloud">Usar los de mi cuenta</button>' +
      '<button class="pc-b alt" data-c="later">Decidir después</button>' +
      '<div class="pc-m" role="status">Lo que no elijas se reemplaza. Si decides después, tus cambios siguen guardados en este dispositivo y no se suben.</div>',
      function (o) {
        o.querySelectorAll('[data-c]').forEach(function (b) {
          b.onclick = function () {
            var c = b.getAttribute('data-c'); close();
            if (c === 'cloud') applyRemote(row); else if (c === 'local') pushNow(true); else setStatus('conflict');
          };
        });
      });
  }

  function pushBlock(sub) {
    if (!VAPID) return '';
    var est = !pushSupported() || (isIOS && !standalone) ? (isIOS && !standalone ? 'En iPhone, agrega la app a tu pantalla de inicio y ábrela desde ese ícono para recibir notificaciones.' : 'Este navegador no permite notificaciones.')
      : Notification.permission === 'granted' && sub ? 'Notificaciones activadas en este dispositivo.'
      : Notification.permission === 'denied' ? 'Notificaciones desactivadas en este dispositivo. ' + pasosAjustes() : 'Notificaciones sin activar en este dispositivo. ' + pasosAjustes();
    return '<h3 style="font-size:16px;margin:18px 0 4px">Notificaciones</h3><div class="pc-m">' + est + '</div>' +
      '<p style="margin:6px 0 0;font-size:14px">Te recordamos anotar tus movimientos a las 8:00, 12:00, 16:00 y 20:00 (hora de Perú). Las notificaciones se activan o desactivan desde los ajustes de tu teléfono.</p>';
    var h = '<h3 style="font-size:16px;margin:18px 0 4px">Avisos de cuotas</h3>';
    h += '<p style="margin:0 0 8px">Te avisamos al celular 1 día antes y el mismo día de cada cuota, a las 10:00 a. m.</p>';
    if (!pushSupported() || (isIOS && !standalone)) {
      h += '<div class="pc-m">' + (isIOS && !standalone
        ? 'En iPhone, primero agrega la app a tu pantalla de inicio (Compartir → “Agregar a pantalla de inicio”) y ábrela desde ese ícono. Luego vuelve aquí para activar los avisos.'
        : 'Este navegador no permite avisos. Prueba con Chrome en Android o instala la app en tu pantalla de inicio.') + '</div>';
    } else if (Notification.permission === 'denied') {
      h += '<div class="pc-m e">Los avisos están bloqueados en este dispositivo. Actívalos en los ajustes del navegador o de la app y vuelve aquí.</div>';
    } else if (sub && Notification.permission === 'granted') {
      h += '<div class="pc-m o">Avisos activados en este dispositivo.</div>' +
        '<button class="pc-b alt" data-pt>Probar aviso</button><button class="pc-b alt" data-pd>Desactivar avisos</button>';
    } else {
      h += '<button class="pc-b" data-pe>Activar avisos en este dispositivo</button><div class="pc-m" data-pm></div>';
    }
    return h;
  }

  function accountSheet() {
    var label = { saving: 'Subiendo cambios…', ok: 'Todo guardado en la nube', offline: 'Sin conexión. Tus cambios siguen en este dispositivo.', error: 'No se pudo sincronizar. Tus cambios siguen en este dispositivo. Toca “Sincronizar ahora” para reintentar.', conflict: 'Hay cambios anteriores a esta actualización. Toca “Sincronizar ahora” para elegir qué conservar.', idle: '' }[status];
    if (status === 'ok' && getMark().dirty) label = 'Hay cambios en este dispositivo sin subir.';
    currentSub().then(function (sub) {
      show(
        '<h2>Tu cuenta</h2><p>' + esc(user.email) + '</p>' +
        '<div class="pc-m ' + (status === 'error' || status === 'conflict' ? 'e' : 'o') + '">' + label + '</div>' +
        '<button class="pc-b alt" data-s>Sincronizar ahora</button>' +
        pushBlock(sub) +
        (standalone ? '' : '<button class="pc-b alt" data-inst>' + IL('account') + '</button>') +
        '<button class="pc-b alt" data-o>Cerrar sesión</button>' +
        '<button class="pc-b alt" data-x>Cerrar</button>' +
        '<button class="pc-l" data-del style="color:#BE4129">Eliminar mi cuenta</button>' +
        '<div class="pc-m e" data-dm style="min-height:0"></div>',
        function (o) {
          o.querySelector('[data-s]').onclick = function () { reconcile().then(function () { if (ov && status !== 'conflict') accountSheet(); }); };
          o.querySelector('[data-o]').onclick = function () {
            clearTimeout(pushTimer); pushTimer = null;
            var dm0 = o.querySelector('[data-dm]');
            Promise.resolve(disablePush()).catch(function () {})            // este dispositivo deja de recibir avisos de esta cuenta
              .then(function () { return getMark().dirty === false ? 'ok' : pushNow(); })
              .then(function (res) {                                         // No borrar si hubo otro guardado durante la subida.
                if (res !== 'ok' || getMark().dirty) { if (dm0) dm0.textContent = 'Hay cambios sin subir. Espera a que termine la sincronización antes de cerrar sesión.'; throw new Error('pendiente'); }
                return sb.auth.signOut();
              })
              .then(function () { wipeLocal(); }, function () {});
          };
          o.querySelector('[data-x]').onclick = close;
          var bInst = o.querySelector('[data-inst]'); if (bInst) bInst.onclick = function () { installSheet(false); };
          o.querySelector('[data-del]').onclick = function () {
            if (!confirm('¿Eliminar tu cuenta? Se borrarán para siempre tus datos (movimientos, deudas, metas y billeteras). Esto no se puede deshacer.')) return;
            if (!confirm('Última confirmación: ¿seguro que quieres eliminar tu cuenta y todos tus datos?')) return;
            var dm = o.querySelector('[data-dm]'), db = o.querySelector('[data-del]'); db.disabled = true;
            Promise.resolve(disablePush()).catch(function () {})
              .then(function () { return sb.rpc('delete_my_account'); })
              .then(function (r) { if (r.error) throw r.error; return sb.auth.signOut(); })
              .then(function () { wipeLocal(); })
              .catch(function () { db.disabled = false; if (dm) dm.textContent = 'No se pudo eliminar la cuenta. Revisa tu internet e inténtalo de nuevo, o escríbenos.'; });
          };
          var pe = o.querySelector('[data-pe]'), pd = o.querySelector('[data-pd]'), pt = o.querySelector('[data-pt]');
          if (pe) pe.onclick = function () {
            pe.disabled = true;
            enablePush().then(function () { accountSheet(); }).catch(function (e) {
              pe.disabled = false;
              var m = o.querySelector('[data-pm]');
              if (m) { m.className = 'pc-m e'; m.textContent = (e && e.message === 'denied') ? 'No diste permiso. Pulsa de nuevo y elige “Permitir”.' : 'No se pudieron activar los avisos. Intenta de nuevo.'; }
            });
          };
          if (pd) pd.onclick = function () { pd.disabled = true; disablePush().then(function () { accountSheet(); }, function () { accountSheet(); }); };
          if (pt) pt.onclick = function () { testPush(); };
        });
    });
  }

  var lastUid = null;
  var syncBar = document.createElement('section');
  syncBar.id = 'pc-sync-status'; syncBar.hidden = true;
  syncBar.setAttribute('aria-label', 'Sincronización');
  syncBar.innerHTML = '<span role="status" aria-live="polite" aria-atomic="true"></span><button type="button" hidden>Reintentar</button>';
  var top = document.querySelector('.top'); if (top) top.insertAdjacentElement('afterend', syncBar);
  var syncStyle = document.createElement('style');
  syncStyle.textContent = '#pc-sync-status{position:fixed;z-index:60;left:50%;top:calc(env(safe-area-inset-top,0px) + 26px);transform:translateX(-50%);width:min(560px,calc(100vw - 24px));box-sizing:border-box;box-shadow:0 10px 28px -12px #0a513c59;display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:10px 14px;margin:0;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);font-size:14px;line-height:1.5}#pc-sync-status[hidden]{display:none}#pc-sync-status span{flex:1;min-width:160px}#pc-sync-status button{min-height:48px;min-width:48px;padding:8px 14px;background:var(--surface2);color:var(--ink);border:1px solid var(--line);border-radius:10px;font:inherit}';
  document.head.appendChild(syncStyle);
  syncBar.querySelector('button').onclick = function () { if (user) reconcile(); else boot(); };
  function paintSync() {
    var m = getMark(), text = '', retry = false;
    if (user || m.uid) {
      var count = m.count || (m.dirty ? 1 : 0), changes = count === 1 ? '1 cambio sin subir' : count + ' cambios sin subir';
      if (status === 'offline' || navigator.onLine === false) text = 'Sin conexión. ' + (m.dirty ? changes + ', guardados en este dispositivo. Se subirán al volver.' : 'Tus datos siguen en este dispositivo.');
      else if (status === 'error') { text = 'No se pudo sincronizar. ' + (m.dirty ? changes + ', guardados en este dispositivo.' : 'Revisa tu conexión e inténtalo de nuevo.'); retry = true; }
      else if (status === 'conflict') { text = 'Hay cambios por revisar. Tus cambios siguen en este dispositivo.'; retry = true; }
      else if (m.dirty) text = 'Subiendo… ' + changes + ', guardados en este dispositivo.';
      else if (status === 'ok' && successVisible) text = mergeNotice || 'En tu cuenta ✓';
    }
    syncBar.hidden = !text;
    var label = syncBar.querySelector('span');
    // El estado de progreso no interrumpe al lector de pantalla.
    label.setAttribute('aria-live', status === 'saving' ? 'off' : 'polite');
    if (label.textContent !== text) label.textContent = text;
    syncBar.querySelector('button').hidden = !retry;
  }
  function paint() {
    if (syncBar) paintSync();
    if (user && consentOK && (firstDone || getMark().uid === user.id)) unlock();
    if ((user && user.id) !== lastUid) { lastUid = user && user.id; nt.err = ''; refreshNotif(); }
    if (!btn) return;
    btn.classList.toggle('on', !!user);
    btn.setAttribute('aria-label', user ? 'Tu cuenta' : 'Ingresar');
    btn.title = user ? (status === 'error' ? 'Error al sincronizar' : status === 'conflict' ? 'Cambios por revisar' : getMark().dirty ? 'Cambios sin subir' : 'Sincronizado') : 'Ingresar';
  }

  if (btn) btn.addEventListener('click', function () {
    client().then(function () { return sb.auth.getSession(); }).then(function (r) {
      user = r.data.session ? r.data.session.user : null;
      if (user) accountSheet(); else accessSheet();
    }).catch(function () { show('<h2>Sin conexión</h2><p>No se pudo cargar el inicio de sesión. Revisa tu internet.</p><button class="pc-b" data-x>Cerrar</button>', function (o) { o.querySelector('[data-x]').onclick = close; }); });
  });

  /* Arranque coordinado: boot() y onAuthStateChange llegan aqui; una sola comprobacion y una sola lectura por cuenta. */
  var entering = null, enterUid = null, firstDone = false;
  function enter() {
    if (!user) return Promise.resolve(false);
    if (entering && enterUid === user.id) return entering;
    enterUid = user.id; firstDone = getMark().uid === user.id;   // dispositivo conocido: sus datos locales ya son de esta cuenta
    var uid = user.id;
    entering = checkConsent().then(function (ok) {
      if (!ok || !user || user.id !== uid) { if (!ok) entering = null; return false; }
      if (ov && !firstDone) close();   // cierra el acceso; mientras llega la nube se ve la pantalla inicial, no datos de ejemplo
      paint(); reconcile(); return true;
    });
    return entering;
  }
  // Primer resultado de la nube en un dispositivo nuevo: recien ahora se muestran los datos (nunca los de ejemplo u otra cuenta).
  function firstReady() {
    if (!user || firstDone) return;
    if (getMark().uid === user.id) { firstDone = true; paint(); return; }   // ya bajo o subio los datos de esta cuenta
    if (ov) return;   // hay una pregunta abierta (que datos conservar): la app sigue oculta hasta que responda
    if (status === 'error') show('<h2>No se pudieron cargar tus datos</h2><p>Revisa tu conexión e inténtalo de nuevo. Tus datos están a salvo en tu cuenta.</p><button class="pc-b" data-r>Reintentar</button><button class="pc-l" data-o>Cerrar sesión</button>', function (o) {
      o.querySelector('[data-r]').onclick = function () { close(); reconcile(); };
      o.querySelector('[data-o]').onclick = function () { sb.auth.signOut().then(function () { wipeLocal(); }); };
    }, true);
  }
  // Sin red se muestra la app enseguida: esperar a las fuentes (no a un temporizador) evita que el texto salte al cambiar de letra.
  function unlockReady() {
    var go = function () { unlock(); };
    // Tambien espera a DOMContentLoaded: ahi ya corrio dashboard.js (defer), que da su estilo final a la vista.
    var dom = document.readyState === 'loading' ? new Promise(function (r) { document.addEventListener('DOMContentLoaded', r, { once: true }); }) : Promise.resolve();
    var fonts; try { fonts = Promise.all([document.fonts.load('400 16px Figtree'), document.fonts.load('700 16px "Bricolage Grotesque"')]); } catch (e) { fonts = Promise.resolve(); }
    Promise.all([dom, fonts.catch(function () {})]).then(go, go);
  }
  // Respaldo, no la solucion principal: si nada respondio en 20 s, no dejar la pantalla inicial para siempre.
  var wdTimer = null;
  function watchdog() {
    clearTimeout(wdTimer);
    wdTimer = setTimeout(function () {
      if (!root.classList.contains('pc-lock') || ov) return;
      show('<h2>Está tardando más de lo normal</h2><p>Revisa tu conexión e inténtalo de nuevo.</p><button class="pc-b" data-r>Reintentar</button>', function (o) { o.querySelector('[data-r]').onclick = function () { location.reload(); }; }, true);
    }, 20000);
  }
  /* Compuerta: la app no se ve hasta ingresar. again=true: reintento silencioso (volver a la app, reconexion) sin tapar lo que la persona usa. */
  function boot(again) {
    // Un dispositivo conocido puede abrir y guardar sin esperar la librería de acceso ni la red.
    if (navigator.onLine === false && getMark().uid) { unlockReady(); setStatus('offline'); return; }
    if (again !== true) { lock(); watchdog(); }
    // Sin sesion guardada ni enlace de acceso en la URL: el acceso no necesita esperar la libreria.
    var saved = false; try { saved = Object.keys(localStorage).some(function (k) { return /^sb-.*-auth-token$/.test(k); }); } catch (e) { saved = true; }
    if (again !== true && !saved && !/access_token|refresh_token|[?&]code=|error_description/.test(location.hash + location.search)) accessSheet();
    client().then(function () { return sb.auth.getSession(); }).then(function (r) {
      if (r.data.session) { if (!user) { user = r.data.session.user; } enter(); }
      else if (again !== true && !(ov && ov.querySelector('[data-m]'))) accessSheet();
    }).catch(function () {
      if (getMark().uid) { unlockReady(); setStatus('offline'); return; }   // dejar usar sin internet y marcar también guardados sin sesión cargada
      if (again === true) return;
      show('<h2>Sin conexión</h2><p>Necesitas internet para ingresar la primera vez.</p><button class="pc-b" data-r>Reintentar</button>',
        function (o) { o.querySelector('[data-r]').onclick = function () { boot(); }; });
    });
  }
  var ctoken = null; try { ctoken = new URLSearchParams(location.search).get('consent'); } catch (e) {}
  if (ctoken) { lock(); consentSheet(ctoken); } else boot();
})();
