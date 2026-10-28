// FieldFlow signature pad. A plain script (no build step): paste it into the app's JavaScript
// settings, then mount it from a component callback (widgets/README.md).
//
// Edit mode puts a drawing canvas next to a form's Signature (Long Text) input and writes the
// signature into that input as a PNG data URL. The native form saves it; this widget never calls
// an API. View mode shows a saved signature as an image.
(function () {
  'use strict';

  const DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;
  const SLUG = /^[A-Za-z0-9_-]+$/;
  const instances = new WeakMap();

  // Only a PNG data URL under the size cap is ever used as an image source.
  function isSignature(value, maxBytes) {
    return typeof value === 'string' && value.length <= maxBytes && DATA_URL.test(value);
  }

  // Form controls hold their value in .value; anything else shows it as text. (An <li> or <meter>
  // has a numeric .value that isn't what's displayed.)
  function readValue(node) {
    const raw = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : node.textContent;
    return (raw || '').trim();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function setStatus(status, text, isError) {
    status.textContent = text;
    status.classList.toggle('ff-sig-error', Boolean(isError));
  }

  // A second mount returns the same instance while it's still in place. After a re-render that
  // kept the element but replaced its contents (or after an error that may be fixed now), the old
  // instance is torn down and the widget mounts again.
  function mount(target, options) {
    if (!(target instanceof Element)) return { destroy() {}, live: () => false };
    const existing = instances.get(target);
    if (existing) {
      if (existing.live()) return existing;
      existing.destroy();
    }

    const opts = Object.assign({ mode: 'edit', maxBytes: 100000, height: 200 }, options);
    const instance = opts.mode === 'view' ? mountView(target, opts) : mountEdit(target, opts);
    instances.set(target, instance);
    target.setAttribute('data-fieldflow-signature', opts.mode);
    return instance;
  }

  function release(target, instance) {
    if (instances.get(target) === instance) instances.delete(target);
    target.removeAttribute('data-fieldflow-signature');
  }

  // A visible error inside the component, so a wrong slug or a missing field doesn't fail
  // silently. Never live: the next mount tries again.
  function mountError(target, message) {
    const box = el('div', 'ff-sig');
    const status = el('p', 'ff-sig-status');
    status.setAttribute('role', 'status');
    setStatus(status, message, true);
    box.append(status);
    target.append(box);
    const instance = {
      live: () => false,
      destroy() {
        box.remove();
        release(target, instance);
      },
    };
    return instance;
  }

  function mountView(target, opts) {
    const value = readValue(target);
    const box = el('div', 'ff-sig ff-sig-view');
    if (isSignature(value, opts.maxBytes)) {
      const img = el('img', 'ff-sig-image');
      img.alt = 'Customer signature';
      img.src = value;
      box.append(img);
    } else {
      box.append(el('p', 'ff-sig-status', 'No signature'));
    }
    // The value element shows a long data URL as text: hide it and show the image after it.
    const hideTarget = Boolean(target.parentNode);
    if (hideTarget) {
      target.classList.add('ff-sig-hidden');
      target.after(box);
    } else {
      target.append(box);
    }
    const instance = {
      live: () => (hideTarget ? box.parentNode !== null && box.parentNode === target.parentNode : target.contains(box)) && readValue(target) === value,
      destroy() {
        box.remove();
        if (hideTarget) target.classList.remove('ff-sig-hidden');
        release(target, instance);
      },
    };
    return instance;
  }

  function mountEdit(target, opts) {
    const slug = opts.signatureField;
    if (typeof slug !== 'string' || !SLUG.test(slug)) return mountError(target, 'Signature pad: no valid signatureField set.');
    const input = target.querySelector('[name="' + slug + '"]');
    if (!input) return mountError(target, 'Signature pad: the signature field was not found on this form.');

    const canvas = el('canvas', 'ff-sig-canvas');
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    // Without a 2D context nobody can sign here; leave the form usable and say so.
    if (!ctx) return mountError(target, "Signature pad: this browser can't draw here.");

    const box = el('div', 'ff-sig');
    const status = el('p', 'ff-sig-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    const clear = el('button', 'ff-sig-clear', 'Clear');
    clear.type = 'button';
    canvas.setAttribute('aria-label', 'Signature area: sign with a finger, pen or mouse');
    canvas.style.height = opts.height + 'px';
    const actions = el('div', 'ff-sig-actions');
    actions.append(status, clear);
    box.append(canvas, actions);

    // The input stays in the form, visually hidden but not display:none, so the native Save
    // submits it and a "required" check can still point at it.
    input.classList.add('ff-sig-offscreen');
    input.after(box);

    const ratio = window.devicePixelRatio || 1;
    const listeners = new AbortController();
    const on = (node, type, fn) => node.addEventListener(type, fn, { signal: listeners.signal });
    let drawing = false;
    let activeId;
    let hasInk = false;

    // Match the canvas's pixels to its displayed size. Checked again before each stroke, since a
    // form in a popup can be 0 wide at mount, and a tablet can rotate. Skipped while there's a
    // signature on the pad: resizing a canvas erases it.
    function fit() {
      if (hasInk) return;
      const width = Math.round((box.clientWidth || 400) * ratio);
      const height = Math.round(opts.height * ratio);
      if (canvas.width === width && canvas.height === height) return;
      canvas.width = width;
      canvas.height = height;
      ctx.lineWidth = 2.5 * ratio;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111';
    }

    function setValue(value) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    // Canvas pixels from a pointer event: the canvas is styled to the box width, so scale.
    function point(event) {
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width ? canvas.width / rect.width : 1;
      const sy = rect.height ? canvas.height / rect.height : 1;
      return { x: (event.clientX - rect.left) * sx, y: (event.clientY - rect.top) * sy };
    }

    // Saved at 1x, so the size doesn't grow with the device's pixel density.
    function exportPng() {
      if (ratio === 1) return canvas.toDataURL('image/png');
      const out = document.createElement('canvas');
      out.width = Math.round(canvas.width / ratio);
      out.height = Math.round(canvas.height / ratio);
      const outCtx = out.getContext('2d');
      if (!outCtx) return canvas.toDataURL('image/png');
      outCtx.drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/png');
    }

    function commit() {
      const url = exportPng();
      if (!isSignature(url, opts.maxBytes)) {
        // Never leave an earlier, smaller copy in the field: what's saved must match the pad.
        setValue('');
        setStatus(status, 'The signature is too large to save. Clear it and sign again.', true);
        return;
      }
      setValue(url);
      setStatus(status, 'Signed', false);
    }

    on(canvas, 'pointerdown', (event) => {
      // One pointer at a time: a palm or a second finger doesn't join the stroke.
      if (drawing || event.button > 0) return;
      event.preventDefault();
      fit();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        // Capture is a nicety (strokes that leave the box); drawing works without it.
      }
      drawing = true;
      hasInk = true;
      activeId = event.pointerId;
      const p = point(event);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y); // a tap leaves a dot
      ctx.stroke();
    });
    on(canvas, 'pointermove', (event) => {
      if (!drawing || event.pointerId !== activeId) return;
      const p = point(event);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    });
    const end = (event) => {
      if (!drawing || event.pointerId !== activeId) return;
      drawing = false;
      commit();
    };
    on(canvas, 'pointerup', end);
    on(canvas, 'pointercancel', end);
    on(clear, 'click', () => {
      drawing = false;
      hasInk = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      setValue('');
      setStatus(status, 'Sign in the box above', false);
    });

    fit();
    if (isSignature(input.value, opts.maxBytes)) {
      // A signature saved earlier is drawn back onto the pad.
      hasInk = true;
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      img.src = input.value;
      setStatus(status, 'Signed', false);
    } else {
      // Anything else in the field (stray text, an oversized image) would be saved back while the
      // pad looks unsigned, and would satisfy a "required" rule. Clear it.
      if (input.value.trim() !== '') setValue('');
      setStatus(status, 'Sign in the box above', false);
    }

    const instance = {
      live: () => target.contains(box) && target.contains(input),
      destroy() {
        listeners.abort();
        box.remove();
        input.classList.remove('ff-sig-offscreen');
        release(target, instance);
      },
    };
    return instance;
  }

  const root = (window.FieldFlow = window.FieldFlow || {});
  root.signaturePad = { mount, isSignature };
})();
