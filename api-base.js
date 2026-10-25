// Resolves the API origin for checkout and upload.
// manualos.com uses window.MANUALOS_API_BASE from config.js.
// Every other host defaults to the local test backend, never the production origin.
(function () {
  var LOCAL_API_DEFAULT = 'http://localhost:8787';
  var PRODUCTION_API_HOST = 'manualforge-backend-production.up.railway.app';
  var STORAGE_KEY = 'manualos_api_base';

  function httpOrigin(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    try {
      var url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
      if (!url.hostname) return '';
      return url.origin;
    } catch (err) {
      return '';
    }
  }

  function hostOf(value) {
    var origin = httpOrigin(value);
    if (!origin) return '';
    try {
      return new URL(origin).hostname.toLowerCase().replace(/\.+$/, '');
    } catch (err) {
      return '';
    }
  }

  function isProductionHost(hostname) {
    var host = String(hostname || location.hostname || '').toLowerCase().replace(/\.+$/, '');
    return host === 'manualos.com' || host === 'www.manualos.com';
  }

  function isProductionBackend(origin) {
    return hostOf(origin) === PRODUCTION_API_HOST;
  }

  function overrideFromQuery() {
    try {
      return httpOrigin(new URLSearchParams(location.search).get('api'));
    } catch (err) {
      return '';
    }
  }

  function overrideFromStorage() {
    try {
      return httpOrigin(localStorage.getItem(STORAGE_KEY));
    } catch (err) {
      return '';
    }
  }

  function resolveApiBase() {
    if (isProductionHost()) {
      return httpOrigin(window.MANUALOS_API_BASE) || ('https://' + PRODUCTION_API_HOST);
    }
    return overrideFromQuery() || overrideFromStorage() || LOCAL_API_DEFAULT;
  }

  function checkoutBlockReason(apiBase) {
    var base = apiBase || resolveApiBase();
    if (!isProductionHost() && isProductionBackend(base)) {
      return 'Checkout is blocked on this preview. It would use the production backend. Point this page at a test backend and try again.';
    }
    return '';
  }

  function ensureBannerStyle() {
    if (document.getElementById('test-mode-banner-style')) return;
    var style = document.createElement('style');
    style.id = 'test-mode-banner-style';
    style.textContent = [
      '.test-mode-banner{position:fixed;z-index:80;left:0;right:0;bottom:0;width:100%;max-width:100%;box-sizing:border-box;margin:0;padding:.4rem .7rem;background:#17181a;color:#f3f0e6;font:500 .8rem/1.35 "IBM Plex Mono",ui-monospace,monospace;text-align:center;overflow-wrap:anywhere;word-break:break-word}',
      'body:has(.test-mode-banner){padding-bottom:2.6rem}',
      '@media print{.test-mode-banner{display:none !important}body:has(.test-mode-banner){padding-bottom:0 !important}}'
    ].join('');
    document.head.appendChild(style);
  }

  function mountTestBanner(apiBase) {
    if (isProductionHost()) return;
    ensureBannerStyle();
    var base = apiBase || resolveApiBase();
    var bar = document.getElementById('test-mode-banner');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'test-mode-banner';
      bar.className = 'test-mode-banner';
      bar.setAttribute('role', 'status');
      var parent = document.querySelector('main') || document.body;
      parent.appendChild(bar);
    }
    var text = 'TEST MODE: backend ' + base;
    if (bar.textContent !== text) bar.textContent = text;
  }

  function publish(apiBase) {
    var base = apiBase || resolveApiBase();
    document.documentElement.dataset.apiBase = base;
    if (!isProductionHost() && isProductionBackend(base)) {
      document.documentElement.dataset.apiBlocked = 'production';
    } else {
      delete document.documentElement.dataset.apiBlocked;
    }
    if (isProductionHost()) {
      var href = httpOrigin(base);
      if (href && !document.querySelector('link[data-api-preconnect]')) {
        var link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = href;
        link.crossOrigin = 'anonymous';
        link.setAttribute('data-api-preconnect', 'true');
        document.head.appendChild(link);
      }
      return;
    }
    mountTestBanner(base);
  }

  window.ManualOSApi = {
    LOCAL_API_DEFAULT: LOCAL_API_DEFAULT,
    STORAGE_KEY: STORAGE_KEY,
    resolveApiBase: resolveApiBase,
    isProductionHost: isProductionHost,
    isProductionBackend: isProductionBackend,
    checkoutBlockReason: checkoutBlockReason,
    mountTestBanner: mountTestBanner
  };

  function boot() {
    publish();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
