(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = { events: [], ev: null, slug: '', guests: [] };
  var DEFAULT_MSG = 'Dear {name},\nYou are warmly invited to our celebration. Please open your personal invitation here:\n{link}';

  // ---------- helpers
  function api(method, path, body) {
    var opt = { method: method, headers: {} };
    if (method !== 'GET') { opt.headers['content-type'] = 'application/json'; opt.body = JSON.stringify(body || {}); }
    return fetch(path, opt).then(function (r) {
      if (r.status === 401) { location.href = '/login'; return new Promise(function () {}); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); throw e; }
        return d;
      });
    }, function () { throw new Error('No connection. Please check your internet and try again.'); });
  }
  var toastT;
  function toast(t) {
    var el = $('toast'); el.textContent = t; el.classList.add('show');
    clearTimeout(toastT); toastT = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function copy(text) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); return ok;
    }
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, function () { return fallback(); });
    }
    return Promise.resolve(fallback());
  }
  function doCopy(text, okMsg) {
    copy(text).then(function (ok) { toast(ok ? okMsg : 'Could not copy. Please press and hold the link instead.'); });
  }
  function linkFor(g) { return location.origin + '/' + state.slug + '/' + g.code; }
  function msgKey() { return 'mc-msg-' + (state.ev ? state.ev.id : 0); }
  function getTemplate() { try { return localStorage.getItem(msgKey()) || DEFAULT_MSG; } catch (e) { return DEFAULT_MSG; } }
  function messageFor(g) {
    return getTemplate().replace(/\{name\}/g, g.name).replace(/\{link\}/g, linkFor(g));
  }
  function fmtDate(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function fmtEventDate(s) {
    var p = s.split('-'); var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }

  // ---------- load
  function init() {
    api('GET', '/api/me').then(function (me) {
      state.events = me.events;
      if (!me.events.length) { $('evTitle').textContent = 'No invitation yet'; $('evMeta').textContent = 'Please contact us to set up your invitation.'; return; }
      if (me.events.length > 1) {
        var sel = $('evSel'); sel.hidden = false; sel.style.marginBottom = '10px';
        me.events.forEach(function (e, i) { var o = el('option', null, e.title_en); o.value = i; sel.appendChild(o); });
        sel.addEventListener('change', function () { pick(+sel.value); });
      }
      pick(0);
    }).catch(function (e) { $('evTitle').textContent = 'Could not load'; $('evMeta').textContent = e.message; });
  }
  function pick(i) {
    state.ev = state.events[i];
    $('evTitle').textContent = state.ev.title_en;
    $('evMeta').textContent = '';
    var meta = $('evMeta');
    meta.appendChild(document.createTextNode(fmtEventDate(state.ev.event_date) + ' '));
    var c = el('span', 'chip' + (state.ev.status === 'live' ? ' live' : ''), state.ev.status === 'draft' ? 'not live yet' : state.ev.status);
    meta.appendChild(c);
    $('result').hidden = true;
    ['addCard', 'listCard', 'msgCard'].forEach(function (id) { $(id).hidden = false; });
    $('msgText').value = getTemplate();
    loadGuests();
  }
  function loadGuests() {
    api('GET', '/api/guests?event=' + state.ev.id).then(function (d) {
      state.slug = d.slug; state.guests = d.guests; render();
    }).catch(function (e) { $('list').textContent = e.message; });
  }

  // ---------- list
  function render(flashId) {
    var q = $('q').value.trim().toLowerCase();
    var list = $('list'); list.textContent = '';
    var opened = state.guests.filter(function (g) { return g.opens > 0; }).length;
    $('nGuests').textContent = state.guests.length; $('nOpened').textContent = opened;
    var shown = state.guests.filter(function (g) { return !q || g.name.toLowerCase().indexOf(q) !== -1; });
    if (!shown.length) {
      list.appendChild(el('div', 'empty', state.guests.length ? 'No guest matches your search.' : 'No guests yet. Add the first name above.'));
      return;
    }
    shown.forEach(function (g) { list.appendChild(row(g, g.id === flashId)); });
    if (flashId) { var f = list.querySelector('.flash'); if (f) f.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function row(g, flash) {
    var r = el('div', 'guest' + (flash ? ' flash' : ''));
    r.appendChild(el('div', 'name', g.name));
    var sub = el('div', 'sub link');
    sub.appendChild(el('span', 'u', location.host + '/' + state.slug + '/' + g.code));
    r.appendChild(sub);
    var st = el('div', 'sub');
    if (g.opens > 0) {
      st.appendChild(el('span', 'chip opened', 'Opened' + (g.opens > 1 ? ' ' + g.opens + '×' : '')));
      if (g.last_opened) st.appendChild(document.createTextNode(' ' + fmtDate(g.last_opened)));
    } else st.appendChild(el('span', 'chip', 'Not opened yet'));
    r.appendChild(st);
    var a = el('div', 'actions');
    var b1 = el('button', 'btn small', 'Copy link'); b1.type = 'button';
    b1.addEventListener('click', function () { doCopy(linkFor(g), 'Link copied'); });
    var b2 = el('button', 'btn small ghost', 'Copy message'); b2.type = 'button';
    b2.addEventListener('click', function () { doCopy(messageFor(g), 'Message copied'); });
    var b3 = el('button', 'btn small ghost', 'Edit'); b3.type = 'button';
    b3.addEventListener('click', function () { editRow(r, g); });
    var b4 = el('button', 'btn small danger', 'Delete'); b4.type = 'button';
    b4.addEventListener('click', function () { askDelete(g); });
    [b1, b2, b3, b4].forEach(function (b) { a.appendChild(b); });
    r.appendChild(a);
    return r;
  }
  function editRow(r, g) {
    r.textContent = '';
    var e = el('div', 'edit');
    var inp = el('input'); inp.type = 'text'; inp.maxLength = 120; inp.value = g.name; inp.setAttribute('aria-label', 'Guest name');
    var save = el('button', 'btn small', 'Save'); save.type = 'button';
    var cancel = el('button', 'btn small ghost', 'Cancel'); cancel.type = 'button';
    e.appendChild(inp); e.appendChild(save); e.appendChild(cancel);
    var err = el('div', 'err'); err.setAttribute('role', 'alert');
    r.appendChild(e); r.appendChild(err);
    inp.focus(); inp.select();
    function go() {
      save.disabled = true;
      api('PATCH', '/api/guests/' + g.id, { name: inp.value }).then(function (d) {
        g.name = d.name; render(g.id); toast('Name changed. The link stays the same.');
      }).catch(function (x) { err.textContent = x.message; save.disabled = false; });
    }
    save.addEventListener('click', go);
    cancel.addEventListener('click', function () { render(); });
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') go(); if (ev.key === 'Escape') render(); });
  }

  // ---------- delete
  var toDelete = null;
  function askDelete(g) {
    toDelete = g;
    $('delP').textContent = 'The link for "' + g.name + '" will stop working immediately. This cannot be undone.';
    $('delBg').hidden = false; $('delNo').focus();
  }
  $('delNo').addEventListener('click', function () { $('delBg').hidden = true; toDelete = null; });
  $('delYes').addEventListener('click', function () {
    var g = toDelete; if (!g) return;
    $('delYes').disabled = true;
    api('DELETE', '/api/guests/' + g.id).then(function () {
      state.guests = state.guests.filter(function (x) { return x.id !== g.id; });
      if ($('resUrl').textContent === linkFor(g)) $('result').hidden = true;
      $('delBg').hidden = true; toDelete = null; render(); toast('Deleted');
    }).catch(function (e) { toast(e.message); $('delBg').hidden = true; }).then(function () { $('delYes').disabled = false; });
  });

  // ---------- add
  function showResult(g) {
    $('resName').textContent = g.name;
    $('resUrl').textContent = linkFor(g);
    $('resLink').onclick = function () { doCopy(linkFor(g), 'Link copied'); };
    $('resMsg').onclick = function () { doCopy(messageFor(g), 'Message copied'); };
    $('result').hidden = false;
  }
  function add(names, btn) {
    $('addErr').textContent = '';
    btn.disabled = true;
    api('POST', '/api/guests', { event: state.ev.id, names: names }).then(function (d) {
      d.guests.forEach(function (g) { state.guests.push(g); });
      $('q').value = '';
      if (d.guests.length === 1) {
        showResult(d.guests[0]); $('oneName').value = ''; $('oneName').focus();
        render(d.guests[0].id);
      } else {
        $('result').hidden = true; $('manyNames').value = ''; render(d.guests[0].id);
        toast(d.guests.length + ' guests added');
      }
    }).catch(function (e) { $('addErr').textContent = e.message; }).then(function () { btn.disabled = false; });
  }
  $('oneAdd').addEventListener('click', function () { add([$('oneName').value], $('oneAdd')); });
  $('oneName').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('oneAdd').click(); } });
  $('manyAdd').addEventListener('click', function () { add($('manyNames').value.split(/\r?\n/), $('manyAdd')); });
  $('toMany').addEventListener('click', function () { $('single').hidden = true; $('many').hidden = false; $('addErr').textContent = ''; $('manyNames').focus(); });
  $('toOne').addEventListener('click', function () { $('many').hidden = true; $('single').hidden = false; $('addErr').textContent = ''; });
  $('q').addEventListener('input', function () { render(); });

  // ---------- message template
  $('msgToggle').addEventListener('click', function () { $('msgbox').hidden = !$('msgbox').hidden; });
  $('msgSave').addEventListener('click', function () {
    try { localStorage.setItem(msgKey(), $('msgText').value); toast('Message saved'); } catch (e) { toast('Could not save on this browser'); }
  });
  $('msgReset').addEventListener('click', function () {
    try { localStorage.removeItem(msgKey()); } catch (e) {}
    $('msgText').value = DEFAULT_MSG; toast('Standard message restored');
  });

  // ---------- password and logout
  $('pwBtn').addEventListener('click', function () { $('pwErr').textContent = ''; $('pwCur').value = ''; $('pwNew').value = ''; $('pwBg').hidden = false; $('pwCur').focus(); });
  $('pwNo').addEventListener('click', function () { $('pwBg').hidden = true; });
  $('pwYes').addEventListener('click', function () {
    $('pwErr').textContent = ''; $('pwYes').disabled = true;
    api('POST', '/api/password', { current: $('pwCur').value, next: $('pwNew').value }).then(function () {
      $('pwBg').hidden = true; toast('Password changed');
    }).catch(function (e) { $('pwErr').textContent = e.message; }).then(function () { $('pwYes').disabled = false; });
  });
  $('outBtn').addEventListener('click', function () {
    api('POST', '/api/logout').then(function () { location.href = '/login'; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { $('delBg').hidden = true; $('pwBg').hidden = true; }
  });

  init();
})();
