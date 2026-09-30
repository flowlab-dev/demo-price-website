/* Page behaviour for the Northgate demo. Plain script, no framework, no
   network. All arithmetic lives in quote.js so the tests measure the same
   code the visitor runs. */
(function () {
  'use strict';

  var Q = window.NGQuote;
  var root = document.documentElement;

  /* ------------------------------------------------------------- theme */

  var STORE_KEY = 'ng-theme';
  var toggle = document.getElementById('theme-toggle');
  var themeLabel = document.getElementById('theme-label');

  function prefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function currentTheme() {
    var set = root.getAttribute('data-theme');
    if (set === 'dark' || set === 'light') return set;
    return prefersDark() ? 'dark' : 'light';
  }

  function paintToggle() {
    if (!toggle || !themeLabel) return;
    var dark = currentTheme() === 'dark';
    themeLabel.textContent = dark ? 'Day shift' : 'Night shift';
    toggle.setAttribute('aria-label', dark ? 'Switch to day shift colours' : 'Switch to night shift colours');
    toggle.setAttribute('aria-pressed', dark ? 'true' : 'false');
  }

  try {
    var stored = localStorage.getItem(STORE_KEY);
    if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);
  } catch (e) { /* private mode: the system setting still works */ }

  paintToggle();

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = currentTheme() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(STORE_KEY, next); } catch (e) { /* ignore */ }
      paintToggle();
    });
  }

  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (root.getAttribute('data-theme') === 'auto') paintToggle(); };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  /* --------------------------------------------------- hero drawing once */

  var drawing = document.getElementById('hero-drawing');
  if (drawing && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    drawing.classList.remove('dw-animate');
  }

  /* ---------------------------------------------------------- the form */

  var form = document.getElementById('rfq-form');
  if (!form || !Q) return;

  var materialSel = document.getElementById('material');
  var thicknessSel = document.getElementById('thickness');
  var alertBox = document.getElementById('form-alert');
  var stateEl = document.getElementById('estimate-state');
  var emptyEl = document.getElementById('estimate-empty');
  var figuresEl = document.getElementById('estimate-figures');
  var flagsEl = document.getElementById('estimate-flags');
  var receipt = document.getElementById('receipt');
  var receiptRef = document.getElementById('receipt-ref');
  var receiptText = document.getElementById('receipt-text');
  var receiptMail = document.getElementById('receipt-mail');
  var copyBtn = document.getElementById('receipt-copy');
  var copyState = document.getElementById('copy-state');

  function fillThickness(keepValue) {
    var material = Q.MATERIALS[materialSel.value];
    var previous = keepValue === undefined ? thicknessSel.value : keepValue;
    thicknessSel.textContent = '';
    material.thickness.forEach(function (mm) {
      var option = document.createElement('option');
      option.value = String(mm);
      option.textContent = mm.toFixed(1) + ' mm';
      thicknessSel.appendChild(option);
    });
    var wanted = material.thickness.indexOf(parseFloat(previous)) > -1 ? previous : '2.0';
    if (material.thickness.indexOf(parseFloat(wanted)) === -1) wanted = String(material.thickness[0]);
    thicknessSel.value = String(parseFloat(wanted));
  }

  fillThickness('2.0');
  materialSel.addEventListener('change', function () { fillThickness(); update(); });

  function readForm() {
    var data = {};
    ['partName', 'material', 'thickness', 'length', 'width', 'quantity', 'bends', 'holes',
      'finish', 'tolerance', 'neededBy', 'contactName', 'company', 'email', 'notes'].forEach(function (name) {
      var el = document.getElementById(name);
      data[name] = el ? el.value : '';
    });
    return data;
  }

  function fieldWrap(name) {
    var el = document.getElementById(name);
    return el ? el.closest('.field') : null;
  }

  function showErrors(errors) {
    Object.keys(errors).forEach(function (name) {
      var wrap = fieldWrap(name);
      var msg = document.getElementById('err-' + name);
      if (wrap) wrap.classList.add('is-bad');
      if (msg) msg.textContent = errors[name];
      var input = document.getElementById(name);
      if (input) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', describedBy(name, true));
      }
    });
  }

  function clearError(name) {
    var wrap = fieldWrap(name);
    var msg = document.getElementById('err-' + name);
    if (wrap) wrap.classList.remove('is-bad');
    if (msg) msg.textContent = '';
    var input = document.getElementById(name);
    if (input) {
      input.removeAttribute('aria-invalid');
      var quiet = describedBy(name, false);
      if (quiet) input.setAttribute('aria-describedby', quiet);
      else input.removeAttribute('aria-describedby');
    }
  }

  /* A field can be described by its hint, its error, or both. */
  function describedBy(name, withError) {
    var ids = [];
    if (withError) ids.push('err-' + name);
    if (document.getElementById('hint-' + name)) ids.push('hint-' + name);
    return ids.join(' ');
  }

  function clearAllErrors() {
    ['partName', 'material', 'thickness', 'length', 'width', 'quantity', 'bends', 'holes',
      'finish', 'tolerance', 'neededBy', 'contactName', 'company', 'email', 'notes'].forEach(clearError);
    if (alertBox) { alertBox.classList.remove('is-on'); alertBox.textContent = ''; }
  }

  /* An estimate needs less than a full RFQ: enough to size the job. */
  var lastBlock = null;

  function estimateInput(data) {
    var probe = Q.validate({
      partName: data.partName || 'Unnamed part',
      material: data.material,
      thickness: data.thickness,
      length: data.length,
      width: data.width,
      quantity: data.quantity,
      bends: data.bends,
      holes: data.holes,
      finish: data.finish,
      tolerance: data.tolerance,
      neededBy: data.neededBy,
      contactName: data.contactName || 'Not given yet',
      email: data.email || 'not.given@example.com'
    });
    var blocking = ['material', 'thickness', 'length', 'width', 'quantity', 'bends', 'holes', 'finish', 'tolerance', 'neededBy'];
    lastBlock = null;
    for (var i = 0; i < blocking.length; i++) {
      if (probe.errors[blocking[i]]) {
        // Only complain about a field the person has actually filled in.
        if (!isFilled(data[blocking[i]])) return null;
        lastBlock = probe.errors[blocking[i]];
        return null;
      }
    }
    return probe.values;
  }

  function isFilled(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
  }

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function flag(text, quiet) {
    var p = document.createElement('p');
    p.className = 'flagline' + (quiet ? ' is-quiet' : '');
    p.textContent = text;
    return p;
  }

  function update() {
    var values = estimateInput(readForm());
    if (!values) {
      emptyEl.hidden = false;
      figuresEl.hidden = true;
      emptyEl.textContent = lastBlock ||
        'Material, thickness, flat size and quantity are enough to get a number. The rest sharpens it.';
      stateEl.textContent = lastBlock ? 'on hold' : 'waiting';
      announce(lastBlock ? 'The estimate is on hold. ' + lastBlock : '');
      return;
    }

    var result = Q.estimate(values);
    emptyEl.hidden = true;
    figuresEl.hidden = false;
    stateEl.textContent = 'live';

    setText('estimate-range', Q.priceRange(result));
    setText('estimate-sub', 'for ' + result.quantity + (result.quantity === 1 ? ' part, ' : ' parts, ') +
      'about ' + Q.money(result.perPart) + ' each');
    setText('row-material', Q.money(result.breakdown.material));
    setText('row-laser', Q.money(result.breakdown.laser));
    setText('row-forming', Q.money(result.breakdown.forming));
    setText('row-hand', Q.money(result.breakdown.hand + result.breakdown.inspection));
    setText('row-finish', Q.money(result.breakdown.finishing));
    setText('row-lead', result.leadDays + ' business days');

    flagsEl.textContent = '';
    if (result.rush) {
      flagsEl.appendChild(flag('Your date is ' + result.rushDaysShort + ' business day' +
        (result.rushDaysShort === 1 ? '' : 's') + ' inside our normal lead time. A ' +
        Math.round(Q.SHOP.rushSurcharge * 100) + ' percent rush surcharge is already in the figure above.'));
    }
    if (result.belowMinimum) {
      flagsEl.appendChild(flag('This job prices below our ' + Q.money(Q.SHOP.minimumJob) +
        ' minimum, so the minimum is what you see. Adding parts costs very little from here.'));
    }
    if (result.overCeiling) {
      flagsEl.appendChild(flag('A job this size gets quoted by a person, not by a web page. Send the file and we will come back the same day.'));
    }
    flagsEl.appendChild(flag(result.setupMinutes + ' minutes of setup is spread across the run, which is why the price per part falls as the quantity climbs.', true));
    flagsEl.appendChild(flag('Ready around ' + Q.formatDate(result.readyBy) + ' if approved today.', true));

    announce('Estimate ' + Q.priceRange(result) + ' for ' + result.quantity +
      (result.quantity === 1 ? ' part' : ' parts') + ', ready in ' + result.leadDays + ' business days.');
  }

  /* One short spoken line, and only after typing stops. */
  var announceEl = document.getElementById('estimate-announce');
  var announceTimer = null;
  function announce(text) {
    if (!announceEl) return;
    if (announceTimer) clearTimeout(announceTimer);
    announceTimer = setTimeout(function () {
      announceEl.textContent = text;
    }, 450);
  }

  function retireReceipt() {
    if (!receipt.classList.contains('is-on')) return;
    receipt.classList.remove('is-on');
    copyState.textContent = '';
  }

  form.addEventListener('input', function (event) {
    if (event.target && event.target.id) clearError(event.target.id);
    retireReceipt();
    update();
  });
  form.addEventListener('change', function () {
    retireReceipt();
    update();
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearAllErrors();

    var data = readForm();
    var checked = Q.validate(data);

    if (!checked.ok) {
      showErrors(checked.errors);
      var count = Object.keys(checked.errors).length;
      alertBox.textContent = count === 1
        ? 'One field needs fixing. The note under it says what to change.'
        : count + ' fields need fixing. The note under each one says what to change.';
      alertBox.classList.add('is-on');
      var first = Q.firstErrorField(checked.errors);
      var el = first ? document.getElementById(first) : null;
      if (el) el.focus();
      else alertBox.focus();
      receipt.classList.remove('is-on');
      return;
    }

    var result = Q.estimate(checked.values);
    var ref = Q.reference(checked.values);
    var text = Q.summaryText(checked.values, result, ref);

    receiptRef.textContent = ref;
    receiptText.textContent = text;
    receiptMail.setAttribute('href', 'mailto:quotes@northgatemetalworks.example' +
      '?subject=' + encodeURIComponent('RFQ ' + ref + ' - ' + checked.values.partName) +
      '&body=' + encodeURIComponent(text));
    copyState.textContent = '';
    receipt.classList.add('is-on');
    receipt.focus();
    receipt.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  copyBtn.addEventListener('click', function () {
    var text = receiptText.textContent;
    function done(ok) {
      copyState.textContent = ok ? 'Copied.' : 'Select the text above and copy it.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(area);
      done(ok);
    } catch (e) {
      done(false);
    }
  });

  /* The example is the bracket drawn in the hero, so the two agree. */
  var example = document.getElementById('fill-example');
  if (example) {
    example.addEventListener('click', function () {
      clearAllErrors();
      var fields = {
        partName: 'Mount bracket NG-2291',
        material: 'crs',
        length: '390',
        width: '220',
        quantity: '50',
        bends: '2',
        holes: '5',
        finish: 'powder',
        tolerance: 'standard'
      };
      Object.keys(fields).forEach(function (name) {
        var el = document.getElementById(name);
        if (el) el.value = fields[name];
      });
      fillThickness('2.0');
      update();
      var next = document.getElementById('contactName');
      if (next) next.focus();
    });
  }

  update();
})();
