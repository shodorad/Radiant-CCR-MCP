/**
 * Keeps "My decks" honest while someone is looking at it.
 *
 * The demo turns on the notification appearing between two other actions, so
 * the page cannot wait for a reload. This polls the same endpoint the page was
 * rendered from and re-renders the rows — the staleness it shows is computed
 * server-side from the live content, not simulated here.
 */
(function (Drupal, drupalSettings, once) {
  'use strict';

  function render(tbody, rows) {
    if (!rows.length) {
      tbody.innerHTML = '<tr class="ccr-decks__empty"><td colspan="5">No decks have been generated yet.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (row) {
      // Per slide, not per deck: "2 of 3 slides are out of date" is a sentence
      // somebody can act on, and it is the reason the definition is stored.
      var status = row.stale
        ? '<span class="ccr-badge ccr-badge--stale">Out of date</span>' +
          '<span class="ccr-note">' + row.stale_count + ' of ' + row.slide_count +
          ' slide' + (row.slide_count === 1 ? '' : 's') + '</span>'
        : '<span class="ccr-badge ccr-badge--current">Up to date</span>';
      var slides = (row.slides || []).map(function (slide) {
        return '<li class="' + (slide.stale ? 'is-stale' : 'is-current') + '">' +
          slide.n + '. ' + escape(slide.template) +
          (slide.items ? '<span class="ccr-note">' + slide.items + ' pillars</span>' : '') +
          (slide.stale ? '<span class="ccr-note">changed ' + escape(slide.changed_ago) + ' ago</span>' : '') +
          '</li>';
      }).join('');
      var action = row.regenerate
        ? '<a class="ccr-button ccr-button--small" href="' + row.regenerate + '">Regenerate</a>'
        : '';
      return '<tr class="' + (row.stale ? 'is-stale' : 'is-current') + '" data-ccr-row="' + escape(row.id) + '">' +
        '<td>' + escape(row.title) + '<ul class="ccr-slides">' + slides + '</ul></td>' +
        '<td>' + escape(row.owner) + '</td>' +
        '<td>' + escape(row.ago) + ' ago</td>' +
        '<td>' + status + '</td>' +
        '<td>' + action + '</td>' +
        '</tr>';
    }).join('');
  }

  function escape(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function summarise(node, stale) {
    node.textContent = stale
      ? stale + ' deck' + (stale === 1 ? '' : 's') + ' out of date'
      : 'Everything is up to date';
    node.className = 'ccr-dashboard__summary' + (stale ? ' is-stale' : ' is-current');
  }

  Drupal.behaviors.ccrDeckDashboard = {
    attach: function (context) {
      once('ccr-dashboard', '[data-ccr-dashboard]', context).forEach(function (root) {
        var settings = (drupalSettings.ccrPoc || {});
        var tbody = root.querySelector('[data-ccr-rows]');
        var summary = root.querySelector('[data-ccr-summary]');
        var signature = null;

        function poll() {
          fetch(settings.feedUrl, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (data) {
              if (!data) return;
              var next = JSON.stringify(data.rows);
              if (next !== signature) {
                signature = next;
                render(tbody, data.rows);
              }
              summarise(summary, data.stale);
            })
            .catch(function () { /* a failed poll is not worth interrupting anyone over */ });
        }

        poll();
        setInterval(poll, (settings.pollSeconds || 5) * 1000);
      });
    },
  };
})(Drupal, drupalSettings, once);
