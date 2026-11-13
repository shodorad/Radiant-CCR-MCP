/**
 * "Shorten to fit" — an offer, beside any line that has outgrown the slide.
 *
 * The counter under each field already says when a line is longer than the deck
 * template holds, and lets the marketer keep it. This adds one thing: when a
 * line is over, a button that asks for a version that fits. The answer is shown
 * next to the original and nothing changes until a person says so — and once it
 * has, "Put mine back" undoes it, because replacing an editor's contents also
 * throws away the editor's own undo history.
 *
 * Three things this script deliberately does not know:
 *
 *   the limit      read off `data-maxlength`, which the counter already put on
 *                  the field from the template's card. One author for the number.
 *   the template   it sends the record's name for the line and the text. What
 *                  box that lands in is the deck channel's business.
 *   what fits      a suggestion arrives already measured against the real box.
 *                  If none fitted, none arrives, and the reason is shown instead.
 */
(function (Drupal, drupalSettings, once) {
  'use strict';

  var settings = (drupalSettings.ccrPoc || {}).assist || {};
  var token = null;

  /** Drupal's field name, out of `a[0][subform][field_pillar_name][0][value]`. */
  function fieldOf(el) {
    var m = /([a-z0-9_]+)\]?\[\d+\]\[value\]$/.exec(el.name || '');
    return m ? m[1] : null;
  }

  function editorOf(el) {
    var id = el.dataset.ckeditor5Id;
    return id && Drupal.CKEditor5Instances ? Drupal.CKEditor5Instances.get(id) || null : null;
  }

  function read(el) {
    var editor = editorOf(el);
    return editor ? editor.getData() : el.value;
  }

  function write(el, value) {
    var editor = editorOf(el);
    if (editor) {
      editor.setData(value);
      return;
    }
    el.value = value;
    // The counter listens for typing, and this was not typing.
    ['input', 'keyup', 'change'].forEach(function (type) {
      el.dispatchEvent(new Event(type, { bubbles: true }));
    });
  }

  /** Parsed, never inserted: this is only ever asked for its text or its nodes. */
  function parse(html) {
    return new DOMParser().parseFromString('<body>' + html, 'text/html').body;
  }

  /** What a character limit counts — the text with the markup taken out. */
  function plainLength(el) {
    var value = read(el);
    return (editorOf(el) ? parse(value).textContent : value).trim().length;
  }

  /** Text and <strong>, rebuilt node by node rather than trusted as markup. */
  function showInline(target, html) {
    target.textContent = '';
    (function walk(node, emphasised) {
      node.childNodes.forEach(function (child) {
        if (child.nodeType === Node.TEXT_NODE) {
          var holder = emphasised ? document.createElement('strong') : document.createDocumentFragment();
          holder.appendChild(document.createTextNode(child.textContent));
          target.appendChild(holder);
        }
        else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child, emphasised || /^(STRONG|B|EM|I)$/.test(child.tagName));
        }
      });
    })(parse(html), false);
  }

  function csrf() {
    if (!token) {
      token = fetch(settings.tokenUrl, { credentials: 'same-origin' }).then(function (r) { return r.text(); });
    }
    return token;
  }

  function ask(body) {
    return csrf()
      .then(function (value) {
        return fetch(settings.url, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': value },
          body: JSON.stringify(body),
        });
      })
      .then(function (r) { return r.json(); })
      .catch(function () {
        return { ok: false, reason: Drupal.t('Could not ask for a shorter version just now. Your text has not been changed.') };
      });
  }

  /** The name of the pillar a description belongs to, so the rewrite is about it too. */
  function aboutOf(el, field) {
    var sibling = (settings.about || {})[field];
    var group = sibling && el.closest('.paragraphs-subform');
    var input = group && Array.prototype.find.call(group.querySelectorAll('input, textarea'), function (candidate) {
      return fieldOf(candidate) === sibling;
    });
    return input ? input.value.trim() : '';
  }

  function button(label, modifier) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'button button--small' + (modifier ? ' ' + modifier : '');
    b.textContent = label;
    return b;
  }

  function attach(el) {
    var field = fieldOf(el);
    var source = (settings.sources || {})[field];
    var limit = parseInt(el.dataset.maxlength, 10);
    var home = el.closest('.js-form-item') || el.parentNode;
    if (!source || !limit || !home) return null;
    // A rich text field is a form item inside a form item, and the help text
    // and the counter belong to the outer one. The offer goes after both: the
    // counter says the line is over, and this is what can be done about it.
    if (home.parentElement && home.parentElement.matches('.js-form-item')) home = home.parentElement;

    var root = document.createElement('div');
    root.className = 'ccr-assist';
    root.hidden = true;

    var askButton = button(Drupal.t('Shorten to fit'), 'ccr-assist__ask');
    var status = document.createElement('p');
    status.className = 'ccr-assist__status';
    status.setAttribute('role', 'status');
    var offer = document.createElement('p');
    offer.className = 'ccr-assist__offer';
    var useButton = button(Drupal.t('Use this'), 'button--primary');
    var keepButton = button(Drupal.t('Keep mine'));
    var undoButton = button(Drupal.t('Put mine back'));
    var actions = document.createElement('div');
    actions.className = 'ccr-assist__actions';
    actions.append(useButton, keepButton, undoButton);
    root.append(askButton, status, offer, actions);
    home.appendChild(root);

    // idle | asking | offered | declined | applied
    var state = 'idle';
    var asked = null;      // the text the current offer is about
    var suggestion = null;
    var mine = null;       // the editor's own text, kept so it can be put back
    var bound = false;

    function show() {
      var over = plainLength(el) > limit;
      root.hidden = state === 'idle' && !over;
      askButton.hidden = !(over && (state === 'idle' || state === 'declined' || state === 'asking'));
      askButton.disabled = state === 'asking';
      offer.hidden = state !== 'offered';
      useButton.hidden = keepButton.hidden = state !== 'offered';
      undoButton.hidden = state !== 'applied';
      status.hidden = state === 'idle';
    }

    function refresh() {
      // CKEditor arrives after this script does. Hear about its changes once it
      // has: a click on its Bold or Undo button is not a keystroke.
      var editor = editorOf(el);
      if (editor && !bound) {
        bound = true;
        editor.model.document.on('change:data', refresh);
      }
      // An offer is about the text it was asked about. If that text has moved
      // on, so should the offer.
      if ((state === 'offered' || state === 'declined') && read(el) !== asked) state = 'idle';
      // Compared as text: the rich text editor hands the suggestion back
      // wrapped in a paragraph, which is not the marketer having edited it.
      if (state === 'applied' && parse(read(el)).textContent.trim() !== parse(suggestion).textContent.trim()) state = 'idle';
      show();
    }

    askButton.addEventListener('click', function () {
      asked = read(el);
      state = 'asking';
      status.textContent = Drupal.t('Looking for a version that fits the slide…');
      show();

      ask({ source: source, value: asked, about: aboutOf(el, field) }).then(function (answer) {
        if (read(el) !== asked) { state = 'idle'; return show(); }
        if (answer.ok && answer.suggestion) {
          suggestion = answer.suggestion;
          state = 'offered';
          showInline(offer, suggestion);
          status.textContent = Drupal.t('Suggested — @chars characters, and it fits the slide in @lines.', {
            '@chars': answer.after.chars,
            '@lines': Drupal.formatPlural(answer.after.lines, '1 line', '@count lines'),
          });
        }
        else {
          state = 'declined';
          status.textContent = answer.reason || Drupal.t('No shorter version was offered.');
        }
        show();
      });
    });

    useButton.addEventListener('click', function () {
      mine = asked;
      state = 'applied';
      write(el, suggestion);
      status.textContent = Drupal.t('Replaced. Nothing is saved until you save the page.');
      show();
    });

    keepButton.addEventListener('click', function () {
      state = 'idle';
      show();
    });

    undoButton.addEventListener('click', function () {
      state = 'idle';
      write(el, mine);
      refresh();
    });

    return refresh;
  }

  Drupal.behaviors.ccrWritingAssistant = {
    attach: function (context) {
      if (!settings.url) return;

      // Pillars arrive by AJAX, so fields are picked up whenever they appear
      // and the form is only wired once.
      var fresh = once('ccr-assist-field', '[data-ccr-assist] [data-maxlength]', context)
        .map(attach)
        .filter(Boolean);

      once('ccr-assist', '[data-ccr-assist]').forEach(function (form) {
        form.ccrAssistRefreshers = [];
        var pending = null;
        var all = function () {
          clearTimeout(pending);
          pending = setTimeout(function () { form.ccrAssistRefreshers.forEach(function (fn) { fn(); }); }, 120);
        };
        ['input', 'keyup', 'change', 'click', 'paste'].forEach(function (type) { form.addEventListener(type, all); });
        // A record saved over the limit should offer the button on arrival, and
        // the rich text editors take a moment to exist.
        [400, 1500, 3500].forEach(function (ms) { setTimeout(all, ms); });
      });

      var form = document.querySelector('[data-ccr-assist]');
      if (form && form.ccrAssistRefreshers) {
        form.ccrAssistRefreshers.push.apply(form.ccrAssistRefreshers, fresh);
        fresh.forEach(function (fn) { fn(); });
      }
    },
  };
})(Drupal, drupalSettings, once);
