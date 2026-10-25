(function () {
  // GET /api/checkout-config returns {managedPayments:boolean} from the backend flag.
  // Reseller copy stays hidden until that value is exactly true. A failed or unfinished call stays on the direct seller.
  var API_BASE = 'https://manualforge-backend-production.up.railway.app';
  var host = location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') API_BASE = location.origin;
  window.manualosManagedPayments = false;

  function apply(on) {
    document.querySelectorAll('[data-seller-note],[data-statement],[data-seller-mp],[data-mp-section]').forEach(function (el) {
      el.hidden = !on;
    });
    document.querySelectorAll('[data-seller-direct],[data-direct-section]').forEach(function (el) {
      el.hidden = on;
    });
  }

  function publish(on) {
    window.manualosManagedPayments = on === true;
    apply(window.manualosManagedPayments);
    document.documentElement.setAttribute('data-checkout-config', window.manualosManagedPayments ? 'mp' : 'direct');
    document.dispatchEvent(new CustomEvent('manualos-checkout-config', {
      detail: { managedPayments: window.manualosManagedPayments }
    }));
  }

  fetch(API_BASE + '/api/checkout-config', { headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('config');
      return res.json();
    })
    .then(function (data) {
      publish(!!(data && data.managedPayments === true));
    })
    .catch(function () {
      publish(false);
    });
})();
