/* SINGLE EDIT AT MERGE
 * This is the only street address. Load this script only on pages that show the footer address slot.
 * While the value is still the unfilled token, this script hides that line.
 * Fill this value at merge. The legal pages keep their date in effective-date.js and do not load this file.
 */
(function () {
  var OP3X_STREET_ADDRESS = '[[OP3X_STREET_ADDRESS]]';
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
