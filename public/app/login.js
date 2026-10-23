(function () {
  var u = document.getElementById('u'), p = document.getElementById('p');
  var err = document.getElementById('err'), go = document.getElementById('go');

  // /login/lychhayly fills in the username.
  var m = /^\/login\/([a-z0-9._-]{3,30})\/?$/.exec(location.pathname);
  if (m) { u.value = m[1]; p.focus(); } else { u.focus(); }

  document.getElementById('show').addEventListener('click', function () {
    var hidden = p.type === 'password';
    p.type = hidden ? 'text' : 'password';
    this.textContent = hidden ? 'Hide' : 'Show';
  });

  document.getElementById('f').addEventListener('submit', function (e) {
    e.preventDefault();
    err.textContent = '';
    go.disabled = true; go.textContent = 'Signing in…';
    fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: u.value, password: p.value })
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (x) {
      if (x.ok) { location.href = '/manage'; return; }
      err.textContent = x.d.error || 'Something went wrong. Please try again.';
      go.disabled = false; go.textContent = 'Sign in'; p.select();
    }).catch(function () {
      err.textContent = 'No connection. Please check your internet and try again.';
      go.disabled = false; go.textContent = 'Sign in';
    });
  });
})();
