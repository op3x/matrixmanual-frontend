/* SINGLE EDIT AT MERGE
 * This is the only place the legal-page effective date is set.
 * EFFECTIVE_DATE is the production deploy date.
 * There is no postal address at launch. OP3X_MAILING_ADDRESS stays the bracket placeholder, and this script does not write it.
 * OP3X_STREET_ADDRESS is the only street address. While it is still the unfilled token, this script hides that line.
 * The effective date is filled with the production deploy date when this page is merged.
 * node dev/check-effective-date.mjs fails while that value is still the unfilled token.
 */
(function () {
  var EFFECTIVE_DATE = 'October 25, 2026';
  var OP3X_MAILING_ADDRESS = '[OP3X MAILING ADDRESS]';
  var OP3X_STREET_ADDRESS = '[[OP3X_STREET_ADDRESS]]';
  document.querySelectorAll('[data-effective-date]').forEach(function (node) {
    node.textContent = EFFECTIVE_DATE;
  });
  if (OP3X_MAILING_ADDRESS.charAt(0) !== '[') {
    document.querySelectorAll('[data-mailing-address]').forEach(function (node) {
      node.textContent = OP3X_MAILING_ADDRESS;
    });
  }
  var showStreet = OP3X_STREET_ADDRESS.charAt(0) !== '[';
  document.querySelectorAll('[data-street-address]').forEach(function (node) {
    if (!showStreet) {
      node.textContent = '';
      node.hidden = true;
      return;
    }
    node.textContent = 'Op3x LLC, ' + OP3X_STREET_ADDRESS;
    node.hidden = false;
  });
})();
