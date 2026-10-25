/* SINGLE EDIT AT MERGE
 * This is the only place the legal-page effective date and the public mailing address are set.
 * Replace EFFECTIVE_DATE with the production deploy date.
 * Replace OP3X_MAILING_ADDRESS with the public mailing address.
 * The effective date is filled with the production deploy date when this page is merged.
 * node dev/check-effective-date.mjs fails while that value is still the unfilled token.
 * While OP3X_MAILING_ADDRESS is still the bracket placeholder, the contact line keeps its no-JS fallback.
 */
(function () {
  var EFFECTIVE_DATE = '[[EFFECTIVE_DATE]]';
  var OP3X_MAILING_ADDRESS = '[OP3X MAILING ADDRESS]';
  document.querySelectorAll('[data-effective-date]').forEach(function (node) {
    node.textContent = EFFECTIVE_DATE;
  });
  if (OP3X_MAILING_ADDRESS.charAt(0) !== '[') {
    document.querySelectorAll('[data-mailing-address]').forEach(function (node) {
      node.textContent = OP3X_MAILING_ADDRESS;
    });
  }
})();
