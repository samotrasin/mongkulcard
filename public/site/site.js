// MongkulCard website pages: language switch, Telegram sign-in button, account page.
(function () {
  var root = document.documentElement, body = document.body;
  function $(s) { return document.querySelector(s); }

  // ---- language (remembered on this phone only)
  function setLang(l) {
    root.dataset.lang = l; root.lang = l;
    document.querySelectorAll('#langSw button').forEach(function (b) { b.classList.toggle('on', b.dataset.v === l); });
    try { localStorage.setItem('mc_lang', l); } catch (e) {}
  }
  var saved = null; try { saved = localStorage.getItem('mc_lang'); } catch (e) {}
  setLang(saved === 'en' ? 'en' : 'km');
  var sw = $('#langSw'); if (sw) sw.addEventListener('click', function (e) { var b = e.target.closest('button'); if (b) setLang(b.dataset.v); });

  // ---- sign-in page: Telegram's own button
  if (body.dataset.page === 'signin') {
    var bot = body.dataset.bot;
    if (!bot || bot.indexOf('__') === 0) { $('#notReady').classList.remove('hidden'); return; }
    var s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', bot);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '14');
    s.setAttribute('data-auth-url', body.dataset.authUrl);
    s.setAttribute('data-request-access', 'write');   // lets the MongkulCard bot send order updates
    $('#tgBox').appendChild(s);

    // the bot way (works inside Facebook / Messenger, where Telegram's button often does not)
    var phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent), waiting = false, timer = null, until = 0;
    var btn = $('#botBtn');
    fetch('/api/account/botlogin', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
        if (!j) return;
        until = Date.now() + j.expiresIn * 1000;
        btn.href = phone ? j.app : j.link; if (!phone) { btn.target = '_blank'; btn.rel = 'noopener'; }
        btn.classList.remove('hidden');
      }).catch(function () {});
    function poll() {
      clearTimeout(timer); if (!waiting) return;
      if (Date.now() > until) { location.reload(); return; }
      fetch('/api/account/botlogin', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
        if (j.status === 'done') { location.href = j.next || '/preview/'; return; }
        if (j.status === 'refused' || j.status === 'expired' || j.status === 'none') { location.reload(); return; }
        timer = setTimeout(poll, document.hidden ? 6000 : 2000);
      }).catch(function () { timer = setTimeout(poll, 4000); });
    }
    btn.addEventListener('click', function () { waiting = true; $('#botWait').classList.remove('hidden'); timer = setTimeout(poll, 2500); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden && waiting) poll(); });
  }

  // ---- account page
  if (body.dataset.page === 'account') {
    var bot2 = body.dataset.bot;
    function load() {
      fetch('/api/account/me', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (a) {
        if (!a.signedIn) { location.href = '/signin?next=/account'; return; }
        $('#meName').textContent = a.name;
        $('#meUser').textContent = a.username ? '@' + a.username : '';
        if (a.photo) { var img = new Image(); img.src = a.photo; img.alt = ''; img.referrerPolicy = 'no-referrer'; img.onload = function () { $('#meInitial').replaceWith(img); }; }
        else $('#meInitial').textContent = (a.name || '✦').trim().charAt(0).toUpperCase();
        var st = $('#phoneState');
        if (a.phoneShared) {
          st.className = 'ok';
          st.textContent = '✓ •••' + (a.phoneEnding || '');
          $('#shareBtn').classList.add('hidden'); $('#shareNote').classList.add('hidden');
        } else {
          st.className = 'warn';
          st.textContent = root.dataset.lang === 'km' ? 'មិនទាន់ចែករំលែក' : 'Not shared yet';
          if (bot2 && bot2.indexOf('__') !== 0) {
            $('#shareBtn').href = 'https://t.me/' + bot2 + '?start=phone';
            $('#shareBtn').classList.remove('hidden'); $('#shareNote').classList.remove('hidden');
          }
        }
      }).catch(function () {});
    }
    load();
    // when the customer comes back from Telegram, refresh
    document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });
    $('#logoutBtn').addEventListener('click', function () {
      fetch('/api/account/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: '{}' })
        .then(function () { location.href = '/preview/'; });
    });
  }
})();
