(function () {
  // GET /api/checkout-config returns {managedPayments:boolean} from the backend flag.
  // Card copy does not change with that flag. The attribute gates Pay until the request settles.
  var API_BASE = 'https://manualforge-backend-production.up.railway.app';
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') API_BASE = location.origin;
  window.manualosManagedPayments = false;

  function publish(on) {
    window.manualosManagedPayments = on === true;
    document.documentElement.setAttribute('data-checkout-config', window.manualosManagedPayments ? 'mp' : 'direct');
    document.dispatchEvent(new CustomEvent('manualos-checkout-config', {
      detail: { managedPayments: window.manualosManagedPayments }
    }));
  }

  var finished = false;
  var timer = setTimeout(function () {
    if (finished) return;
    publish(false);
  }, 3000);

  function finish(on) {
    finished = true;
    clearTimeout(timer);
    publish(on);
  }

  fetch(API_BASE + '/api/checkout-config', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('config');
      return res.json();
    })
    .then(function (data) {
      finish(!!(data && data.managedPayments === true));
    })
    .catch(function () {
      finish(false);
    });
})();
