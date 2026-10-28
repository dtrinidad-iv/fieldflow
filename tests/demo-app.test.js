// @vitest-environment jsdom
// The demo page (demo/app.js) builds the board and the job panel from the server's state, with
// record text set as text, and mounts the real widgets.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../demo/app.html'), 'utf8');
let consoleError;

// The shape GET /api/state answers (scripts/demo-server.js state()); the server's own answers are
// tested in tests/demo-server.test.js. (The page test runs in jsdom, which can't import the server.)
const base = { customer: 'Jane Rivera', technicianId: 'tech1', technician: 'Alex Moreno', scheduledDate: '2026-10-29', slot: 'Morning',
  total: 0, signed: false, invoiceProblem: '', scheduleConflict: '', items: [] };
const state = {
  jobs: [
    { ...base, id: 'job1', title: '<img src=x onerror=alert(1)>Replace water heater', status: 'Scheduled', total: 849,
      items: [{ id: 'item1', description: 'Labour (hours)', quantity: '2.5', unitPrice: '$80.00', lineTotal: 200 },
        { id: 'item2', description: '50-gallon water heater', quantity: '1', unitPrice: '$649.00', lineTotal: 649 }] },
    { ...base, id: 'job2', title: 'Annual boiler service', status: 'In Progress', total: 120 },
    { ...base, id: 'job3', title: 'Fix leaking tap', status: 'Completed', signed: true },
    { ...base, id: 'job4', title: 'Install smart thermostat', status: 'Invoiced', total: 189, signed: true,
      invoice: { number: 'INV-job4', amount: 189, issuedDate: '2026-10-28', link: 'https://demo.execute-api.us-east-1.amazonaws.com/invoices/job4.pdf?sig=abc' } },
  ],
  technicians: [{ id: 'tech1', name: 'Alex Moreno' }, { id: 'tech2', name: 'Sam Lee' }],
  slots: ['Morning', 'Afternoon', 'Evening'],
  log: [],
};

beforeAll(async () => {
  consoleError = vi.spyOn(console, 'error');
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, drawImage() {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => state })));
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  window.location.hash = '#job2'; // the page opens the job named in the hash
  await import('../widgets/signature-pad.js');
  await import('../widgets/line-total.js');
  await import('../demo/app.js');
  await vi.waitFor(() => expect(document.querySelectorAll('.card').length).toBeGreaterThan(0));
});

describe('demo page', () => {
  it('opens the job named in the URL hash', () => {
    expect(document.querySelector('#panel h2').textContent).toBe('Annual boiler service');
    // Optional parts that are absent (no flags, no invoice) leave nothing behind.
    expect(document.getElementById('panel').textContent).not.toMatch(/undefined|false|null/);
    expect(document.querySelector('.card[data-id="job2"]').classList.contains('selected')).toBe(true);
  });

  it('shows the four status columns, with Completed and Invoiced locked', () => {
    const columns = [...document.querySelectorAll('.column')];
    expect(columns.map((c) => c.dataset.status)).toEqual(['Scheduled', 'In Progress', 'Completed', 'Invoiced']);
    expect(columns.filter((c) => c.classList.contains('locked')).map((c) => c.dataset.status)).toEqual(['Completed', 'Invoiced']);
  });

  it('renders record text as text, never as HTML', () => {
    expect(document.querySelector('#board img')).toBeNull();
    expect(document.querySelector('.card h3').textContent).toBe('<img src=x onerror=alert(1)>Replace water heater');
  });

  it('only lets open jobs be dragged', () => {
    for (const card of document.querySelectorAll('.card')) {
      const status = card.closest('.column').dataset.status;
      expect(card.getAttribute('draggable')).toBe(['Scheduled', 'In Progress'].includes(status) ? 'true' : 'false');
    }
  });

  it('opens a job panel with the real signature pad and live line total', () => {
    document.querySelector('.card[data-id="job1"]').click();
    const panel = document.getElementById('panel');
    expect(panel.querySelector('h2').textContent).toMatch(/Replace water heater$/);
    expect(panel.querySelector('.complete-form canvas')).not.toBeNull();
    expect(panel.querySelector('.item-form .ff-total')).not.toBeNull();
    expect(panel.querySelector('.items tfoot').textContent).toMatch(/\$849\.00/);
  });

  it('opens an invoice PDF on this server, keeping its path and signature', () => {
    document.querySelector('.card[data-id="job4"]').click();
    expect(document.querySelector('#panel .invoice a').getAttribute('href')).toBe('/invoices/job4.pdf?sig=abc');
  });

  it('logs no errors', () => {
    expect(consoleError).not.toHaveBeenCalled();
  });
});
