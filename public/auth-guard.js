// Shared auth guard for standalone pages — refreshes expired JWT tokens
(async function() {
  function _clearAuth() {
    Object.keys(localStorage).filter(function(k) { return k.startsWith('nfx_'); })
      .forEach(function(k) { localStorage.removeItem(k); });
  }

  async function _refreshToken() {
    var rt = localStorage.getItem('nfx_refresh_token');
    if (!rt) return false;
    try {
      var r = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (!r.ok) return false;
      var d = await r.json();
      if (!d.token) return false;
      localStorage.setItem('nfx_token', d.token);
      localStorage.setItem('nfx_refresh_token', d.refresh_token || rt);
      return true;
    } catch (_) { return false; }
  }

  function _scheduleRefresh(expMs) {
    var delay = Math.max(expMs - Date.now() - 5 * 60 * 1000, 10000);
    setTimeout(async function() {
      var ok = await _refreshToken();
      if (ok) {
        try {
          var tok = localStorage.getItem('nfx_token');
          var pay = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
          _scheduleRefresh(pay.exp * 1000);
        } catch (_) {}
      }
    }, delay);
  }

  var token = localStorage.getItem('nfx_token');
  if (!token) { location.replace('/login'); return; }

  try {
    var pay = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (pay.exp * 1000 < Date.now()) {
      var ok = await _refreshToken();
      if (!ok) { _clearAuth(); location.replace('/login'); return; }
    }
    // Schedule proactive refresh
    try {
      var tok = localStorage.getItem('nfx_token');
      var p = JSON.parse(atob(tok.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
      _scheduleRefresh(p.exp * 1000);
    } catch (_) {}
  } catch (_) {
    _clearAuth();
    location.replace('/login');
  }
})();
