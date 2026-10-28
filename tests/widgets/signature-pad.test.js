// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==';

let pad;
let ctx;
let dataUrl;

beforeAll(async () => {
  await import('../../widgets/signature-pad.js');
  pad = window.FieldFlow.signaturePad;
});

// jsdom has no canvas: stub the 2D context and the export.
beforeEach(() => {
  document.body.replaceChildren();
  ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn() };
  dataUrl = PNG;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => dataUrl);
});

function form(value = '') {
  const section = document.createElement('section');
  const textarea = document.createElement('textarea');
  textarea.name = 'field_906';
  textarea.value = value;
  section.append(textarea);
  document.body.append(section);
  const events = { input: 0, change: 0 };
  textarea.addEventListener('input', () => events.input++);
  textarea.addEventListener('change', () => events.change++);
  return { section, textarea, events };
}

function stroke(canvas) {
  const at = (type, x) => canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 10, button: 0 }));
  at('pointerdown', 5);
  at('pointermove', 20);
  at('pointermove', 40);
  at('pointerup', 40);
}

const status = (root) => root.querySelector('.ff-sig-status');

describe('signature pad, edit mode', () => {
  it('writes the signature to the form input after a stroke, and fires input and change', () => {
    const { section, textarea, events } = form();
    pad.mount(section, { signatureField: 'field_906' });
    expect(status(section).textContent).toBe('Sign in the box above');
    expect(textarea.classList.contains('ff-sig-offscreen')).toBe(true); // not display:none
    expect(textarea.isConnected).toBe(true); // still in the form, so Save submits it

    stroke(section.querySelector('canvas'));
    expect(textarea.value).toBe(PNG);
    expect(events).toEqual({ input: 1, change: 1 });
    expect(ctx.lineTo).toHaveBeenCalledTimes(3);
    expect(status(section).textContent).toBe('Signed');
  });

  it('ignores moves without a pointerdown, and secondary buttons', () => {
    const { section, textarea } = form();
    pad.mount(section, { signatureField: 'field_906' });
    const canvas = section.querySelector('canvas');
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 5 }));
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 2 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', {}));
    expect(ctx.lineTo).not.toHaveBeenCalled();
    expect(textarea.value).toBe('');
  });

  it('Clear empties the pad and the input', () => {
    const { section, textarea, events } = form();
    pad.mount(section, { signatureField: 'field_906' });
    stroke(section.querySelector('canvas'));
    section.querySelector('.ff-sig-clear').click();
    expect(textarea.value).toBe('');
    expect(ctx.clearRect).toHaveBeenCalled();
    expect(events.input).toBe(2);
    expect(status(section).textContent).toBe('Sign in the box above');
  });

  it('is safe to mount twice: one pad, and a stroke is saved once', () => {
    const { section, events } = form();
    const first = pad.mount(section, { signatureField: 'field_906' });
    const second = pad.mount(section, { signatureField: 'field_906' });
    expect(second).toBe(first);
    expect(section.querySelectorAll('canvas')).toHaveLength(1);
    stroke(section.querySelector('canvas'));
    expect(events.input).toBe(1);
  });

  it('refuses a signature over maxBytes, and clears an earlier smaller copy from the input', () => {
    const { section, textarea } = form();
    pad.mount(section, { signatureField: 'field_906', maxBytes: PNG.length });
    const canvas = section.querySelector('canvas');
    stroke(canvas);
    expect(textarea.value).toBe(PNG);
    dataUrl = `${PNG}AAAA`; // more strokes make the export bigger than the cap
    stroke(canvas);
    expect(textarea.value).toBe('');
    expect(status(section).textContent).toMatch(/too large/);
    expect(status(section).classList.contains('ff-sig-error')).toBe(true);
  });

  it('shows a saved signature again and marks it signed', () => {
    const { section } = form(PNG);
    pad.mount(section, { signatureField: 'field_906' });
    expect(status(section).textContent).toBe('Signed');
  });

  it('shows an error, and keeps the input usable, when the browser has no 2D context', () => {
    ctx = null;
    const { section, textarea } = form();
    pad.mount(section, { signatureField: 'field_906' });
    expect(status(section).textContent).toMatch(/can't draw/);
    expect(section.querySelector('canvas')).toBeNull();
    expect(textarea.classList.contains('ff-sig-offscreen')).toBe(false);
  });

  it('shows a visible error when the field is missing or the slug is invalid', () => {
    const { section } = form();
    pad.mount(section, { signatureField: 'field_999' });
    expect(status(section).textContent).toMatch(/not found/);

    const other = form().section;
    pad.mount(other, { signatureField: '"],[x' });
    expect(status(other).textContent).toMatch(/no valid signatureField/);

    const error = pad.mount(form().section, {});
    expect(() => error.destroy()).not.toThrow();
  });

  it('does nothing, without throwing, when the target element is missing', () => {
    expect(() => pad.mount(null, { signatureField: 'field_906' }).destroy()).not.toThrow();
    expect(() => pad.mount(undefined).destroy()).not.toThrow();
  });

  it('destroy removes the pad and its listeners, and shows the input again', () => {
    const { section, textarea, events } = form();
    const instance = pad.mount(section, { signatureField: 'field_906' });
    const canvas = section.querySelector('canvas');
    instance.destroy();
    expect(section.querySelector('.ff-sig')).toBeNull();
    expect(textarea.classList.contains('ff-sig-offscreen')).toBe(false);
    expect(section.hasAttribute('data-fieldflow-signature')).toBe(false);
    stroke(canvas);
    expect(events.input).toBe(0);
    // It can be mounted again after a destroy.
    expect(pad.mount(section, { signatureField: 'field_906' })).not.toBe(instance);
  });
});

describe('signature pad, review fixes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mounts again when a re-render replaced the input inside the same element', () => {
    const { section, textarea } = form();
    const first = pad.mount(section, { signatureField: 'field_906' });
    // Tadabase re-renders the form's contents, keeping the component element.
    const fresh = document.createElement('textarea');
    fresh.name = 'field_906';
    section.replaceChildren(fresh);
    const second = pad.mount(section, { signatureField: 'field_906' });
    expect(second).not.toBe(first);
    expect(section.querySelectorAll('canvas')).toHaveLength(1);
    expect(fresh.classList.contains('ff-sig-offscreen')).toBe(true);
    expect(textarea.classList.contains('ff-sig-offscreen')).toBe(false);
  });

  it('recovers from "field not found" once the field appears', () => {
    const section = document.createElement('section');
    document.body.append(section);
    pad.mount(section, { signatureField: 'field_906' });
    expect(status(section).textContent).toMatch(/not found/);
    const textarea = document.createElement('textarea');
    textarea.name = 'field_906';
    section.prepend(textarea);
    pad.mount(section, { signatureField: 'field_906' });
    expect(section.querySelectorAll('canvas')).toHaveLength(1);
    expect(section.querySelectorAll('.ff-sig')).toHaveLength(1);
  });

  it('clears a value that is not a valid signature, so it is not saved back', () => {
    const { section, textarea, events } = form('leftover text');
    pad.mount(section, { signatureField: 'field_906' });
    expect(textarea.value).toBe('');
    expect(events.change).toBe(1);
  });

  it('draws a saved signature back onto the pad', () => {
    vi.stubGlobal('Image', class {
      set src(value) {
        this.loaded = value;
        this.onload();
      }
    });
    form(PNG);
    pad.mount(document.querySelector('section'), { signatureField: 'field_906' });
    expect(ctx.drawImage).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage.mock.calls[0][0].loaded).toBe(PNG);
  });

  it('scales pointer positions to canvas pixels', () => {
    const { section } = form();
    pad.mount(section, { signatureField: 'field_906' });
    const canvas = section.querySelector('canvas');
    canvas.width = 400;
    canvas.height = 200;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 200, height: 100 });
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 60, clientY: 45 }));
    expect(ctx.moveTo).toHaveBeenCalledWith(100, 50);
  });

  it('a second pointer does not join the stroke, and pointercancel ends it', () => {
    const { section, textarea } = form();
    pad.mount(section, { signatureField: 'field_906' });
    const canvas = section.querySelector('canvas');
    const fire = (type, pointerId, x = 5) => {
      const event = new MouseEvent(type, { button: 0, clientX: x });
      Object.defineProperty(event, 'pointerId', { value: pointerId });
      canvas.dispatchEvent(event);
    };
    fire('pointerdown', 1);
    fire('pointerdown', 2); // a palm
    fire('pointermove', 2, 50);
    fire('pointerup', 2);
    expect(ctx.moveTo).toHaveBeenCalledTimes(1);
    expect(ctx.lineTo).toHaveBeenCalledTimes(1); // only the first pointer's dot
    expect(textarea.value).toBe('');
    fire('pointercancel', 1);
    expect(textarea.value).toBe(PNG);
  });

  it('saves at 1x on a high-density screen', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const { section, textarea } = form();
    pad.mount(section, { signatureField: 'field_906' });
    const canvas = section.querySelector('canvas');
    expect(canvas.width).toBe(1200);
    stroke(canvas);
    const [source, , , width, height] = ctx.drawImage.mock.calls[0];
    expect(source).toBe(canvas);
    expect([width, height]).toEqual([400, 200]);
    expect(textarea.value).toBe(PNG);
  });
});

describe('signature pad, view mode', () => {
  function valueElement(text) {
    const div = document.createElement('div');
    div.textContent = text;
    document.body.append(div);
    return div;
  }

  it('shows a PNG data URL as an image and hides the raw text', () => {
    const div = valueElement(`  ${PNG}\n`);
    pad.mount(div, { mode: 'view' });
    const img = document.querySelector('img');
    expect(img.getAttribute('src')).toBe(PNG);
    expect(img.alt).toBe('Customer signature');
    expect(div.classList.contains('ff-sig-hidden')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['javascript URL', 'javascript:alert(1)'],
    ['remote URL', 'https://evil.test/x.png'],
    ['SVG data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['markup after the data', `${PNG}"><script>alert(1)</script>`],
    ['HTML', '<img src=x onerror=alert(1)>'],
  ])('shows "No signature" for %s, as text, and never sets an image source', (_label, text) => {
    const div = valueElement(text);
    pad.mount(div, { mode: 'view' });
    expect(document.querySelectorAll('img, script')).toHaveLength(0);
    expect(status(document.body).textContent).toBe('No signature');
  });

  it('shows "No signature" for a value over maxBytes', () => {
    pad.mount(valueElement(PNG), { mode: 'view', maxBytes: 20 });
    expect(document.querySelector('img')).toBeNull();
  });

  it('is safe to mount twice, and destroy restores the text', () => {
    const div = valueElement(PNG);
    const first = pad.mount(div, { mode: 'view' });
    expect(pad.mount(div, { mode: 'view' })).toBe(first);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    first.destroy();
    expect(document.querySelector('img')).toBeNull();
    expect(div.classList.contains('ff-sig-hidden')).toBe(false);
  });

  it('reads the displayed text of any element (an <li> has a numeric .value)', () => {
    const li = document.createElement('li');
    li.textContent = PNG;
    document.body.append(li);
    pad.mount(li, { mode: 'view' });
    expect(document.querySelector('img').getAttribute('src')).toBe(PNG);
  });

  it('shows the new signature when the value changes in place', () => {
    const div = valueElement('');
    const first = pad.mount(div, { mode: 'view' });
    div.textContent = PNG;
    expect(pad.mount(div, { mode: 'view' })).not.toBe(first);
    expect(document.querySelectorAll('img')).toHaveLength(1);
    expect(document.querySelectorAll('.ff-sig')).toHaveLength(1);
  });

  it('works on an element that is not in the page yet', () => {
    const div = document.createElement('div');
    div.textContent = PNG;
    pad.mount(div, { mode: 'view' }).destroy();
    expect(div.querySelector('img')).toBeNull();
  });
});

// The invoice function only invoices a job whose signature passes lib/invoice.js hasSignature. A
// signature the pad saves must pass it, and anything the pad refuses must fail it.
describe('parity with lib/invoice.js hasSignature', () => {
  it.each([
    PNG, '', 'signed by phone', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=',
    `${PNG}"><b>`, 'data:image/png;base64,', `data:image/png;base64,${'A'.repeat(99_978)}`, `data:image/png;base64,${'A'.repeat(99_979)}`,
  ])('%#', async (value) => {
    const { hasSignature, MAX_SIGNATURE_LENGTH } = await import('../../lib/invoice.js');
    expect(pad.isSignature(value, MAX_SIGNATURE_LENGTH)).toBe(hasSignature(value));
  });
});

describe('isSignature', () => {
  it('accepts only PNG data URLs under the cap', () => {
    expect(pad.isSignature(PNG, 1000)).toBe(true);
    expect(pad.isSignature(PNG, 10)).toBe(false);
    expect(pad.isSignature(42, 1000)).toBe(false);
    expect(pad.isSignature('data:image/png;base64,', 1000)).toBe(false);
  });
});
