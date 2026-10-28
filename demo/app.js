// The local demo's page (plan 09): a stand-in for the Tadabase pages, talking to
// scripts/demo-server.js. The board, the job panel and the forms are plain DOM; the signature pad
// and the live line total are the real widgets from widgets/. All record text goes in with
// textContent (lint forbids innerHTML here).
(function () {
  'use strict';

  const COLUMNS = ['Scheduled', 'In Progress', 'Completed', 'Invoiced'];
  const OPEN = ['Scheduled', 'In Progress'];
  const FieldFlow = window.FieldFlow;
  let state = null;
  let selectedId = null;
  let toastTimer;

  // --- small DOM helpers ---
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
    }
    return node;
  }
  const money = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(n) || 0);
  const shortDate = (iso) => {
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  // Invoice links point at the API Gateway domain they'd have in production; here the same path
  // and signature are opened on this server, where the real invoice-pdf handler checks them. Only
  // an /invoices/<id>.pdf path on this page's own origin is ever used as a link.
  const localLink = (link) => {
    try {
      const u = new URL(link);
      const local = new URL(u.pathname + u.search, window.location.origin);
      const ok = local.origin === window.location.origin && /^\/invoices\/[A-Za-z0-9_-]{1,64}\.pdf$/.test(local.pathname);
      return ok ? local.pathname + local.search : null;
    } catch {
      return null;
    }
  };

  function toast(text, kind) {
    const node = document.getElementById('toast');
    node.textContent = text;
    node.className = `toast ${kind || ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 6000);
  }

  // Every POST is JSON: the server refuses anything else (so other sites can't post to it).
  async function api(method, url, body) {
    const post = method === 'POST';
    const res = await fetch(url, {
      method,
      headers: post ? { 'content-type': 'application/json' } : {},
      body: post ? JSON.stringify(body || {}) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  async function action(method, url, body, success) {
    try {
      const data = await api(method, url, body);
      state = data.state || data;
      render();
      if (success) toast(typeof success === 'function' ? success(data) : success, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  // --- the board ---
  function card(job) {
    const draggable = OPEN.includes(job.status);
    const badges = el('div', { class: 'badges' },
      job.scheduleConflict && el('span', { class: 'badge warn', title: job.scheduleConflict }, 'Double-booked'),
      job.invoiceProblem && el('span', { class: 'badge danger', title: job.invoiceProblem }, 'Sent back'),
      job.signed && el('span', { class: 'badge' }, 'Signed'),
      job.invoice && el('span', { class: 'badge ok' }, job.invoice.number));
    return el('article', {
      class: `card${job.id === selectedId ? ' selected' : ''}`,
      draggable: draggable ? 'true' : 'false',
      tabindex: '0',
      'data-id': job.id,
      'aria-label': `${job.title}, ${job.status}`,
      onclick: () => select(job.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(job.id); } },
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', job.id); e.dataTransfer.effectAllowed = 'move'; },
    },
    el('h3', {}, job.title),
    el('p', { class: 'meta' }, job.customer),
    el('p', { class: 'meta' }, `${job.technician} · ${shortDate(job.scheduledDate)} · ${job.slot}`),
    el('p', { class: 'total' }, money(job.total)),
    badges);
  }

  function column(status) {
    const jobs = state.jobs.filter((j) => j.status === status);
    const open = OPEN.includes(status);
    const list = el('div', { class: 'cards' }, jobs.length ? jobs.map(card) : el('p', { class: 'empty-state small' }, 'No jobs'));
    return el('section', {
      class: `column${open ? '' : ' locked'}`,
      'data-status': status,
      ondragover: (e) => { if (open) { e.preventDefault(); e.currentTarget.classList.add('drop'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('drop'),
      ondrop: (e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drop');
        const id = e.dataTransfer.getData('text/plain');
        const job = state.jobs.find((j) => j.id === id);
        if (open && job && job.status !== status) action('POST', `/api/jobs/${encodeURIComponent(id)}/move`, { status }, `Moved to ${status}`);
      },
    },
    el('h2', {}, status, el('span', { class: 'count' }, String(jobs.length))),
    !open && el('p', { class: 'lock-note' }, status === 'Completed' ? 'Only through the Complete job form' : 'Set when the invoice is created'),
    list);
  }

  // --- the job panel ---
  function bookingForm(job) {
    const tech = el('select', { name: 'technicianId', 'aria-label': 'Technician' },
      state.technicians.map((t) => el('option', { value: t.id, selected: t.id === job.technicianId }, t.name)));
    const date = el('input', { type: 'date', name: 'scheduledDate', value: job.scheduledDate, 'aria-label': 'Scheduled date' });
    const slot = el('select', { name: 'slot', 'aria-label': 'Slot' }, state.slots.map((s) => el('option', { value: s, selected: s === job.slot }, s)));
    return el('form', {
      class: 'booking',
      onsubmit: (e) => {
        e.preventDefault();
        action('POST', `/api/jobs/${encodeURIComponent(job.id)}/reschedule`,
          { technicianId: tech.value, scheduledDate: date.value, slot: slot.value }, 'Booking saved (an inline edit: it skips the form rule, so the server-side check runs)');
      },
    },
    el('label', {}, 'Technician', tech), el('label', {}, 'Date', date), el('label', {}, 'Slot', slot),
    el('button', { type: 'submit', class: 'button' }, 'Save booking'));
  }

  function itemsTable(job) {
    if (!job.items.length) return el('p', { class: 'empty-state small' }, 'No line items yet.');
    return el('table', { class: 'items' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Item'), el('th', {}, 'Qty'), el('th', {}, 'Price'), el('th', {}, 'Line total'))),
      el('tbody', {}, job.items.map((i) => el('tr', {}, el('td', {}, i.description), el('td', {}, i.quantity), el('td', {}, i.unitPrice), el('td', {}, money(i.lineTotal))))),
      el('tfoot', {}, el('tr', {}, el('td', { colspan: '3' }, 'Job total'), el('td', {}, money(job.total)))));
  }

  function itemForm(job) {
    const form = el('form', {
      class: 'item-form',
      onsubmit: (e) => {
        e.preventDefault();
        const data = Object.fromEntries(new FormData(form));
        action('POST', `/api/jobs/${encodeURIComponent(job.id)}/items`, data, 'Item added');
      },
    },
    el('label', {}, 'Description', el('input', { name: 'description', required: true, placeholder: 'e.g. Labour (hours)' })),
    el('label', {}, 'Quantity', el('input', { name: 'quantity', inputmode: 'decimal', placeholder: '2.5' })),
    el('label', {}, 'Unit price', el('input', { name: 'unitPrice', inputmode: 'decimal', placeholder: '$80.00' })),
    el('button', { type: 'submit', class: 'button' }, 'Add item'));
    // The real live-total widget: Quantity x Unit Price while typing, with the invoice's rules.
    FieldFlow.lineTotal.mount(form, { quantityField: 'quantity', unitPriceField: 'unitPrice' });
    return form;
  }

  function completeForm(job, keep) {
    const form = el('form', {
      class: 'complete-form',
      onsubmit: (e) => {
        e.preventDefault();
        const signature = form.querySelector('[name="signature"]').value;
        action('POST', `/api/jobs/${encodeURIComponent(job.id)}/complete`, { signature }, (data) => {
          const r = data.result || {};
          if (r.status === 201) return `Invoice ${r.number} created for ${money(r.amount)}; the job moved to Invoiced`;
          if (r.sentBack) return `Not invoiced: ${r.error}. The job was sent back to In Progress.`;
          return 'Completed';
        });
      },
    },
    el('p', { class: 'hint' }, 'The customer signs below. The form sets the status to Completed, and Tadabase would then call the invoice webhook.'),
    el('textarea', { name: 'signature', rows: '2', 'aria-label': 'Signature' }),
    el('button', { type: 'submit', class: 'button primary' }, 'Complete job'));
    form.querySelector('[name="signature"]').value = keep || '';
    // The real signature pad: it fills the form's Signature field with a PNG data URL.
    FieldFlow.signaturePad.mount(form, { signatureField: 'signature', height: 160 });
    return form;
  }

  function panel() {
    const node = document.getElementById('panel');
    const job = state.jobs.find((j) => j.id === selectedId);
    // A signature drawn but not yet submitted survives the panel being rebuilt (after Add item or
    // Save booking): the pad draws a saved value back.
    const pending = node.querySelector('.complete-form [name="signature"]');
    const keep = pending && node.dataset.jobId === selectedId ? pending.value : '';
    node.dataset.jobId = selectedId || '';
    if (!job) {
      node.replaceChildren(el('p', { class: 'empty-state' }, 'Select a job to see its details, add items, or complete it.'));
      return;
    }
    const open = OPEN.includes(job.status);
    const link = job.invoice && localLink(job.invoice.link);
    node.replaceChildren(
      el('div', { class: 'panel-head' },
        el('h2', {}, job.title),
        el('span', { class: `status s-${job.status.replace(' ', '-').toLowerCase()}` }, job.status)),
      el('p', { class: 'meta' }, `${job.customer} · ${job.technician} · ${shortDate(job.scheduledDate)} · ${job.slot}`),
      job.scheduleConflict && el('p', { class: 'flag warn' }, el('strong', {}, 'Schedule Conflict: '), job.scheduleConflict),
      job.invoiceProblem && el('p', { class: 'flag danger' }, el('strong', {}, 'Invoice Problem: '), job.invoiceProblem),
      job.invoice && el('div', { class: 'invoice' },
        el('p', {}, el('strong', {}, job.invoice.number), ` · ${money(job.invoice.amount)} · issued ${job.invoice.issuedDate}`),
        link && el('a', { class: 'button primary', href: link, target: '_blank', rel: 'noopener' }, 'Open invoice PDF')),
      open && el('h3', {}, 'Booking'), open && bookingForm(job),
      el('h3', {}, 'Line items'), itemsTable(job), open && itemForm(job),
      open && el('h3', {}, 'Complete job'), open && completeForm(job, keep),
    );
  }

  function logList() {
    document.getElementById('log').replaceChildren(
      ...(state.log.length ? state.log.map((l) => el('li', {}, el('time', {}, new Date(l.at).toLocaleTimeString()), ' ', l.text))
        : [el('li', { class: 'empty-state small' }, 'Nothing yet. Try completing a job.')]),
    );
  }

  function render() {
    document.getElementById('board').replaceChildren(...COLUMNS.map(column));
    panel();
    logList();
  }

  // Selecting the job that's already open does nothing (no rebuild, no lost input). Focus stays on
  // the card, for keyboard users.
  function select(id) {
    if (id === selectedId) return;
    selectedId = id;
    render();
    const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.id === id);
    if (card) card.focus();
  }

  async function start() {
    document.getElementById('reset').addEventListener('click', () => {
      selectedId = null;
      action('POST', '/api/reset', null, 'Demo data reset');
    });
    try {
      state = await api('GET', '/api/state');
      render();
    } catch (err) {
      document.getElementById('board').replaceChildren(el('p', { class: 'empty-state' }, `Couldn't load the demo: ${err.message}`));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
