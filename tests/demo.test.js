// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const demoDir = resolve(dirname(fileURLToPath(import.meta.url)), '../demo');
const html = readFileSync(resolve(demoDir, 'index.html'), 'utf8');
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
let consoleError;

beforeAll(async () => {
  consoleError = vi.spyOn(console, 'error');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, drawImage() {},
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => PNG);
  // The page's markup without running its <script> tags; the scripts are imported below, in order.
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  await import('../widgets/signature-pad.js');
  await import('../widgets/line-total.js');
  await import('../demo/demo.js');
});

describe('demo page', () => {
  it('references only files that exist', () => {
    const refs = [...document.querySelectorAll('script[src], link[href]')].map((n) => n.getAttribute('src') ?? n.getAttribute('href'));
    expect(refs).toHaveLength(6);
    for (const ref of refs) expect(existsSync(resolve(demoDir, ref)), ref).toBe(true);
  });

  it('mounts both widgets', () => {
    expect(document.querySelectorAll('#complete-job canvas')).toHaveLength(1);
    expect(document.querySelector('#job-item .ff-total-output').textContent).toBe('Line total: $3,086.25');
  });

  it('re-render keeps one of each widget', () => {
    document.getElementById('rerender').click();
    document.getElementById('rerender').click();
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
    expect(document.querySelectorAll('.ff-total')).toHaveLength(1);
  });

  it('a stroke fills the field, and Save shows the signature on the details section', () => {
    const canvas = document.querySelector('#complete-job canvas');
    canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0 }));
    canvas.dispatchEvent(new MouseEvent('pointerup', {}));
    expect(document.getElementById('signature-preview').textContent).toBe(`${PNG.length} characters, starts ${PNG.slice(0, 30)}...`);

    document.getElementById('complete-job-form').requestSubmit();
    expect(document.querySelector('#job-details img').getAttribute('src')).toBe(PNG);
  });

  it('logs no errors', () => {
    expect(consoleError).not.toHaveBeenCalled();
  });
});
