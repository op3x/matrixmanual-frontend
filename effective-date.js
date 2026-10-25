/* SINGLE EDIT AT MERGE
 * This is the only place the legal-page effective date is set.
 * Replace the value below with the production deploy date.
 * The effective date is filled with the production deploy date when this page is merged.
 * node dev/check-effective-date.mjs fails while that value is still the unfilled token.
 */
(function () {
  var EFFECTIVE_DATE = '[[EFFECTIVE_DATE]]';
  document.querySelectorAll('[data-effective-date]').forEach(function (node) {
    node.textContent = EFFECTIVE_DATE;
  });
})();
