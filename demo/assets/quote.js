/*
 * Northgate Metalworks - budgetary estimate engine.
 *
 * One file, two homes: the browser loads it with <script src>, Node tests
 * require() it. No build step, so the page and the tests can never drift.
 *
 * Every number below is a shop-floor assumption written down in the open:
 * a buyer can check it, and a shop can change it without touching the page.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NGQuote = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- data */

  var MATERIALS = {
    crs: {
      id: 'crs',
      label: 'Mild steel (CRS 1008)',
      density: 7.85e-6,        // kg per mm^3
      pricePerKg: 1.45,        // USD, shop cost incl. current surcharges
      thickness: [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0],
      cutFactor: 1.0,
      bendFactor: 1.0
    },
    ss304: {
      id: 'ss304',
      label: 'Stainless 304 (2B)',
      density: 8.0e-6,
      pricePerKg: 4.30,
      thickness: [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0],
      cutFactor: 1.45,         // slower cut, nitrogen assist
      bendFactor: 1.2          // springback, more first-article fiddling
    },
    al5052: {
      id: 'al5052',
      label: 'Aluminium 5052-H32',
      density: 2.68e-6,
      pricePerKg: 5.60,
      thickness: [1.0, 1.2, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0],
      cutFactor: 1.15,
      bendFactor: 1.15
    }
  };

  var FINISHES = {
    mill: { id: 'mill', label: 'Mill finish, deburred', perPart: 0.00, lotMinimum: 0, leadDays: 0 },
    powder: { id: 'powder', label: 'Powder coat, one colour', perPart: 4.20, lotMinimum: 85, leadDays: 2 },
    zinc: { id: 'zinc', label: 'Clear zinc plate', perPart: 3.10, lotMinimum: 110, leadDays: 2 }
  };

  var TOLERANCES = {
    standard: { id: 'standard', label: 'Standard, +/-0.25 mm', formingFactor: 1.0, inspectMinPerPart: 0.15 },
    tight: { id: 'tight', label: 'Tight, +/-0.10 mm', formingFactor: 1.18, inspectMinPerPart: 0.55 }
  };

  var SHOP = {
    sheetMax: { length: 3000, width: 1500 },   // mm, the bed of the laser
    partMin: 20,                                // mm, smallest side we will nest
    quantityMax: 2000,
    bendsMax: 20,
    holesMax: 400,
    laserRate: 95,        // USD per machine hour
    brakeRate: 78,
    inspectRate: 62,
    programMinutes: 25,   // one-off laser programming per part number
    brakeSetupMinutes: 12,// per bend, once per job
    firstArticleMinutes: 30,
    loadMinutesPerPart: 0.35,
    pierceSeconds: 1.4,
    bendSecondsPerHit: 18,
    deburrMinutesPerPart: 0.6,
    scrapFactor: 1.25,    // skeleton and offcut we pay for but do not ship
    margin: 0.32,
    spread: 0.12,         // half-width of the published range
    minimumJob: 150,      // USD, below this it is not worth opening the file
    baseLeadDays: 6,
    rushSurcharge: 0.25,
    areaPerFeature: 900,   // mm^2 of blank per hole or cutout before it is crowded
    mmPerBend: 25,         // the brake needs a flange it can hold
    quoteByHandOver: 50000 // above this a person quotes it, not a web page
  };

  // Laser feed in mm/min at a given thickness for mild steel; other materials
  // scale by cutFactor. Interpolated between the points we actually run.
  var FEED_POINTS = [
    [0.8, 9200], [1.5, 7400], [2.0, 6100], [3.0, 4200], [4.0, 3000], [5.0, 2200], [6.0, 1600]
  ];

  function feedRate(material, thickness) {
    var pts = FEED_POINTS;
    var mmPerMin;
    if (thickness <= pts[0][0]) mmPerMin = pts[0][1];
    else if (thickness >= pts[pts.length - 1][0]) mmPerMin = pts[pts.length - 1][1];
    else {
      mmPerMin = pts[pts.length - 1][1];
      for (var i = 1; i < pts.length; i++) {
        if (thickness <= pts[i][0]) {
          var t0 = pts[i - 1][0], t1 = pts[i][0], f0 = pts[i - 1][1], f1 = pts[i][1];
          mmPerMin = f0 + (f1 - f0) * ((thickness - t0) / (t1 - t0));
          break;
        }
      }
    }
    return mmPerMin / material.cutFactor;
  }

  /* ---------------------------------------------------------- validation */

  var FIELD_ORDER = [
    'partName', 'material', 'thickness', 'length', 'width', 'quantity',
    'bends', 'holes', 'finish', 'tolerance', 'neededBy', 'contactName', 'email'
  ];

  function isBlank(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    var text = String(value).trim().replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(text)) return NaN;
    return parseFloat(text);
  }

  function toInteger(value) {
    if (typeof value === 'number') return Number.isInteger(value) ? value : NaN;
    var text = String(value).trim();
    if (!/^-?\d+$/.test(text)) return NaN;
    return parseInt(text, 10);
  }

  function validateEmail(value) {
    var text = String(value).trim();
    if (text.length > 254) return false;
    return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(text);
  }

  function parseDateOnly(value) {
    var text = String(value).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    var parts = text.split('-').map(Number);
    var stamp = Date.UTC(parts[0], parts[1] - 1, parts[2]);
    var back = new Date(stamp);
    if (back.getUTCFullYear() !== parts[0] || back.getUTCMonth() !== parts[1] - 1 || back.getUTCDate() !== parts[2]) return null;
    return stamp;
  }

  /*
   * Dates in this file are calendar days, not moments. A date input hands us
   * "2026-10-15" with no timezone, so we key every day by UTC midnight and map
   * "now" through the visitor's own calendar first. Without that step a buyer
   * west of UTC gets told that today has already passed.
   */
  function dayKey(stamp) {
    var d = new Date(stamp);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  }

  /**
   * Checks one RFQ. Returns { ok, values, errors } where errors is keyed by
   * field name and every message tells the person what to do next.
   */
  function validate(input, now) {
    input = input || {};
    var errors = {};
    var values = {};
    var today = dayKey(now === undefined ? Date.now() : now);

    var partName = String(input.partName === undefined ? '' : input.partName).trim().replace(/\s+/g, ' ');
    if (isBlank(partName)) errors.partName = 'Name the part so we can label the quote.';
    else if (partName.length < 2) errors.partName = 'Use at least 2 characters.';
    else if (partName.length > 60) errors.partName = 'Keep it under 60 characters.';
    else values.partName = partName;

    var material = MATERIALS[String(input.material === undefined ? '' : input.material).trim()];
    if (!material) errors.material = 'Pick a material we stock.';
    else values.material = material;

    var thickness = toNumber(input.thickness);
    if (isBlank(input.thickness)) errors.thickness = 'Pick a thickness.';
    else if (Number.isNaN(thickness)) errors.thickness = 'Thickness has to be a number in millimetres.';
    else if (!material) errors.thickness = 'Pick a material first.';
    else if (material.thickness.indexOf(thickness) === -1) {
      errors.thickness = 'We stock ' + material.label + ' in ' + material.thickness.map(function (mm) { return mm.toFixed(1); }).join(', ') + ' mm.';
    } else values.thickness = thickness;

    ['length', 'width'].forEach(function (key) {
      var mm = toNumber(input[key]);
      var limit = key === 'length' ? SHOP.sheetMax.length : SHOP.sheetMax.width;
      if (isBlank(input[key])) errors[key] = 'Flat size is needed to nest the part.';
      else if (Number.isNaN(mm) || mm <= 0) errors[key] = 'Enter the flat ' + key + ' in millimetres.';
      else if (mm < SHOP.partMin) errors[key] = 'Smallest side we nest is ' + SHOP.partMin + ' mm.';
      else if (mm > limit) errors[key] = 'Our bed is ' + SHOP.sheetMax.length + ' x ' + SHOP.sheetMax.width + ' mm - this side is over ' + limit + ' mm.';
      else values[key] = mm;
    });

    var quantity = toInteger(input.quantity);
    if (isBlank(input.quantity)) errors.quantity = 'How many parts?';
    else if (Number.isNaN(quantity)) errors.quantity = 'Quantity has to be a whole number.';
    else if (quantity < 1) errors.quantity = 'One part is our minimum - and it is welcome.';
    else if (quantity > SHOP.quantityMax) errors.quantity = 'Over ' + SHOP.quantityMax + ' parts we quote by hand. Send the drawing and we will come back the same day.';
    else values.quantity = quantity;

    var bends = isBlank(input.bends) ? 0 : toInteger(input.bends);
    if (Number.isNaN(bends)) errors.bends = 'Bend count has to be a whole number, 0 if the part stays flat.';
    else if (bends < 0) errors.bends = 'Bends cannot be negative.';
    else if (bends > SHOP.bendsMax) errors.bends = 'Over ' + SHOP.bendsMax + ' hits we quote by hand.';
    else values.bends = bends;

    var holes = isBlank(input.holes) ? 0 : toInteger(input.holes);
    if (Number.isNaN(holes)) errors.holes = 'Holes and cutouts have to be a whole number.';
    else if (holes < 0) errors.holes = 'Holes cannot be negative.';
    else if (holes > SHOP.holesMax) errors.holes = 'Over ' + SHOP.holesMax + ' features we quote from the DXF instead.';
    else values.holes = holes;

    // A part only has room for so much. Past that the arithmetic is fiction,
    // so we ask for the file instead of inventing a price.
    if (values.length && values.width) {
      var roomForHoles = Math.max(4, Math.floor((values.length * values.width) / SHOP.areaPerFeature));
      if (values.holes > roomForHoles) {
        errors.holes = 'A ' + values.length + ' x ' + values.width + ' mm part has room for about ' +
          roomForHoles + ' features. Send the DXF and we will quote from the file.';
        delete values.holes;
      }
      var roomForBends = Math.max(1, Math.floor(Math.max(values.length, values.width) / SHOP.mmPerBend));
      if (values.bends > roomForBends) {
        errors.bends = 'The brake needs about ' + SHOP.mmPerBend + ' mm between hits, so this part takes around ' +
          roomForBends + '. Send the drawing and we will work it out.';
        delete values.bends;
      }
    }

    var finish = FINISHES[String(input.finish === undefined ? 'mill' : input.finish).trim()];
    if (!finish) errors.finish = 'Pick a finish.';
    else values.finish = finish;

    var tolerance = TOLERANCES[String(input.tolerance === undefined ? 'standard' : input.tolerance).trim()];
    if (!tolerance) errors.tolerance = 'Pick a tolerance.';
    else values.tolerance = tolerance;

    if (isBlank(input.neededBy)) {
      values.neededBy = null;
    } else {
      var due = parseDateOnly(input.neededBy);
      if (due === null) errors.neededBy = 'Use the date picker, or leave it empty.';
      else if (due < today) errors.neededBy = 'That date has passed. Pick a day from today on.';
      else values.neededBy = due;
    }

    var contactName = String(input.contactName === undefined ? '' : input.contactName).trim().replace(/\s+/g, ' ');
    if (isBlank(contactName)) errors.contactName = 'Who should we reply to?';
    else if (contactName.length < 2) errors.contactName = 'Use at least 2 characters.';
    else if (contactName.length > 60) errors.contactName = 'Keep it under 60 characters.';
    else values.contactName = contactName;

    var email = String(input.email === undefined ? '' : input.email).trim();
    if (isBlank(email)) errors.email = 'We send the quote by email.';
    else if (!validateEmail(email)) errors.email = 'Check the address - it needs an @ and a domain.';
    else values.email = email;

    var company = String(input.company === undefined ? '' : input.company).trim().replace(/\s+/g, ' ');
    if (company.length > 80) errors.company = 'Keep it under 80 characters.';
    else values.company = company;

    var notes = String(input.notes === undefined ? '' : input.notes).trim();
    if (notes.length > 600) errors.notes = 'Keep notes under 600 characters - the drawing can carry the rest.';
    else values.notes = notes;

    return { ok: Object.keys(errors).length === 0, values: values, errors: errors };
  }

  function firstErrorField(errors) {
    for (var i = 0; i < FIELD_ORDER.length; i++) {
      if (errors[FIELD_ORDER[i]]) return FIELD_ORDER[i];
    }
    var keys = Object.keys(errors);
    return keys.length ? keys[0] : null;
  }

  /* ------------------------------------------------------------ estimate */

  function round2(n) { return Math.round(n * 100) / 100; }

  function addBusinessDays(stamp, days) {
    var d = new Date(stamp);
    var added = 0;
    while (added < days) {
      d = new Date(d.getTime() + 86400000);
      var day = d.getUTCDay();
      if (day !== 0 && day !== 6) added++;
    }
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function businessDaysBetween(from, to) {
    if (to <= from) return 0;
    var d = new Date(from);
    var count = 0;
    while (d.getTime() < to) {
      d = new Date(d.getTime() + 86400000);
      var day = d.getUTCDay();
      if (day !== 0 && day !== 6) count++;
    }
    return count;
  }

  /**
   * Turns validated values into money and days. Pure arithmetic: same input,
   * same output, which is why the tests can pin every line of it.
   */
  function estimate(values, now) {
    var today = dayKey(now === undefined ? Date.now() : now);
    var m = values.material;
    var qty = values.quantity;
    var areaMm2 = values.length * values.width;
    var massKg = areaMm2 * values.thickness * m.density;
    var materialCost = massKg * m.pricePerKg * SHOP.scrapFactor;

    var perimeter = 2 * (values.length + values.width);
    var featureCut = values.holes * 28;          // a typical 9 mm hole plus small cutouts
    var cutLength = perimeter + featureCut;
    var cutMinutes = cutLength / feedRate(m, values.thickness);
    var pierceMinutes = (values.holes + 1) * (SHOP.pierceSeconds / 60);
    var laserMinutesPerPart = cutMinutes + pierceMinutes + SHOP.loadMinutesPerPart;

    var bendMinutesPerPart = values.bends * (SHOP.bendSecondsPerHit / 60) * m.bendFactor * values.tolerance.formingFactor;
    var deburrMinutes = SHOP.deburrMinutesPerPart;
    var inspectMinutesPerPart = values.tolerance.inspectMinPerPart;

    var setupMinutesLaser = SHOP.programMinutes;
    var setupMinutesBrake = values.bends * SHOP.brakeSetupMinutes;
    var setupMinutesInspect = SHOP.firstArticleMinutes;

    var laserCost = (laserMinutesPerPart * qty + setupMinutesLaser) / 60 * SHOP.laserRate;
    var brakeCost = (bendMinutesPerPart * qty + setupMinutesBrake) / 60 * SHOP.brakeRate;
    var handCost = (deburrMinutes * qty) / 60 * SHOP.brakeRate;
    var inspectCost = (inspectMinutesPerPart * qty + setupMinutesInspect) / 60 * SHOP.inspectRate;

    var finishCost = values.finish.perPart * qty;
    if (values.finish.lotMinimum > 0) finishCost = Math.max(finishCost, values.finish.lotMinimum);

    var materialTotal = materialCost * qty;
    var cost = materialTotal + laserCost + brakeCost + handCost + inspectCost + finishCost;

    var leadDays = SHOP.baseLeadDays + values.finish.leadDays;
    if (values.tolerance.id === 'tight') leadDays += 1;
    if (qty > 250) leadDays += 2;
    if (qty > 1000) leadDays += 2;

    var readyBy = addBusinessDays(today, leadDays);
    var rush = false;
    var rushDaysShort = 0;
    if (values.neededBy !== null && values.neededBy !== undefined && values.neededBy < readyBy) {
      rush = true;
      rushDaysShort = businessDaysBetween(values.neededBy, readyBy);
    }

    var price = cost * (1 + SHOP.margin);
    if (rush) price *= (1 + SHOP.rushSurcharge);

    var belowMinimum = price < SHOP.minimumJob;
    if (belowMinimum) price = SHOP.minimumJob;

    // The job minimum is a floor, not a midpoint: a range that starts below it
    // would quote a price we have just said we do not take.
    var low = belowMinimum ? SHOP.minimumJob : round2(price * (1 - SHOP.spread));
    var high = belowMinimum ? SHOP.minimumJob : round2(price * (1 + SHOP.spread));
    var overCeiling = price > SHOP.quoteByHandOver;

    return {
      quantity: qty,
      massKgPerPart: round2(massKg),
      cutLengthMm: Math.round(cutLength),
      laserMinutesPerPart: round2(laserMinutesPerPart),
      bendMinutesPerPart: round2(bendMinutesPerPart),
      setupMinutes: Math.round(setupMinutesLaser + setupMinutesBrake + setupMinutesInspect),
      breakdown: {
        material: round2(materialTotal),
        laser: round2(laserCost),
        forming: round2(brakeCost),
        hand: round2(handCost),
        inspection: round2(inspectCost),
        finishing: round2(finishCost)
      },
      cost: round2(cost),
      total: round2(price),
      low: low,
      high: high,
      perPart: round2(price / qty),
      belowMinimum: belowMinimum,
      overCeiling: overCeiling,
      rush: rush,
      rushDaysShort: rushDaysShort,
      leadDays: leadDays,
      readyBy: readyBy
    };
  }

  /* ----------------------------------------------------------- reference */

  function reference(values, stamp) {
    var d = new Date(dayKey(stamp === undefined ? Date.now() : stamp));
    var yy = String(d.getUTCFullYear()).slice(2);
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    var seed = [values.partName, values.material.id, values.thickness, values.length,
      values.width, values.quantity, values.bends, values.holes, values.email].join('|');
    var hash = 5381;
    for (var i = 0; i < seed.length; i++) {
      hash = ((hash * 33) ^ seed.charCodeAt(i)) >>> 0;
    }
    var letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    var code = '';
    for (var j = 0; j < 2; j++) {
      code += letters[hash % letters.length];
      hash = Math.floor(hash / letters.length);
    }
    code += String(hash % 100).padStart(2, '0');
    return 'NG-' + yy + mm + dd + '-' + code;
  }

  /* ------------------------------------------------------------- summary */

  function formatDate(stamp) {
    if (stamp === null || stamp === undefined) return 'not set';
    var d = new Date(stamp);
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getUTCDate() + ' ' + months[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function money(n) {
    return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** One figure when the price is pinned to the minimum, a range otherwise. */
  function priceRange(result) {
    return result.low === result.high ? money(result.low) : money(result.low) + ' - ' + money(result.high);
  }

  /** The plain-text RFQ a buyer can paste into email or a purchase system. */
  function summaryText(values, result, ref) {
    var lines = [];
    lines.push('REQUEST FOR QUOTE ' + ref);
    lines.push('Northgate Metalworks - laser cutting, forming, welded assemblies');
    lines.push('');
    lines.push('Part:        ' + values.partName);
    lines.push('Material:    ' + values.material.label + ', ' + values.thickness + ' mm');
    lines.push('Flat size:   ' + values.length + ' x ' + values.width + ' mm');
    lines.push('Quantity:    ' + values.quantity);
    lines.push('Bends:       ' + values.bends);
    lines.push('Holes/cuts:  ' + values.holes);
    lines.push('Finish:      ' + values.finish.label);
    lines.push('Tolerance:   ' + values.tolerance.label);
    lines.push('Needed by:   ' + formatDate(values.neededBy));
    lines.push('');
    lines.push('Budgetary estimate: ' + priceRange(result) +
      ' for ' + result.quantity + ' (about ' + money(result.perPart) + ' each)');
    lines.push('Estimated ready:    ' + result.leadDays + ' business days, around ' + formatDate(result.readyBy));
    if (result.rush) lines.push('Rush:               needed ' + result.rushDaysShort + ' business day(s) sooner - rush surcharge included');
    if (result.belowMinimum) lines.push('Note:               below our ' + money(SHOP.minimumJob) + ' job minimum, quoted at the minimum');
    if (result.overCeiling) lines.push('Note:               a job this size is quoted by a person, not by the page');
    lines.push('');
    lines.push('Contact:     ' + values.contactName + (values.company ? ', ' + values.company : ''));
    lines.push('Email:       ' + values.email);
    if (values.notes) {
      lines.push('');
      lines.push('Notes:');
      lines.push(values.notes);
    }
    lines.push('');
    lines.push('This estimate comes from the numbers above, not from a drawing.');
    lines.push('Send the DXF or STEP file in reply and we confirm within one business day.');
    return lines.join('\n');
  }

  return {
    MATERIALS: MATERIALS,
    FINISHES: FINISHES,
    TOLERANCES: TOLERANCES,
    SHOP: SHOP,
    FIELD_ORDER: FIELD_ORDER,
    feedRate: feedRate,
    validate: validate,
    validateEmail: validateEmail,
    parseDateOnly: parseDateOnly,
    firstErrorField: firstErrorField,
    estimate: estimate,
    reference: reference,
    summaryText: summaryText,
    dayKey: dayKey,
    addBusinessDays: addBusinessDays,
    businessDaysBetween: businessDaysBetween,
    formatDate: formatDate,
    money: money,
    priceRange: priceRange
  };
});
