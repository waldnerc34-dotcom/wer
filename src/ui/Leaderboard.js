import { formatLap } from '../game/Timing.js';

/**
 * The record board for one circuit.
 *
 * Every car in one table rather than a table per car, because half the
 * interest is seeing which car is quick here — each row says what it was set
 * in and which aids were on, so nothing is being hidden. Rows set by somebody
 * else are marked, and survive them going offline.
 */

const el = (tag, className, html) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
};

const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ago = (at) => {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
};

/**
 * @param {object} opts
 * @param {object[]} opts.rows from Records.table()
 * @param {object[]} opts.cars the garage, for names
 * @param {string} [opts.driver] whose rows to highlight
 * @param {number} [opts.limit]
 * @returns {HTMLElement}
 */
export function leaderboard({ rows, cars, driver, limit = 10, title = 'Lap records' }) {
  const box = el('section', 'field leaderboard');
  const shown = rows.slice(0, limit);

  box.append(el('header', null, `<label>${title}</label><span>${rows.length || 'none yet'}</span>`));

  if (!shown.length) {
    box.append(el('p', 'hint', 'Set a clean lap and it goes here.'));
    return box;
  }

  const best = shown[0].lap;
  const list = el('ol', 'record-list');
  for (const [i, row] of shown.entries()) {
    const car = cars.find((c) => c.id === row.car);
    const gap = i === 0 ? '' : `+${(row.lap - best).toFixed(3)}`;
    list.append(
      el(
        'li',
        `record-row${row.driver === driver && !row.remote ? ' self' : ''}`,
        `<span class="pos">${i + 1}</span>
         <span class="who">${escape(row.driver)}${row.remote ? ' <em>guest</em>' : ''}</span>
         <span class="car">${car ? escape(car.name) : escape(row.car ?? '—')}</span>
         <span class="aids">${escape(row.aids || '')}</span>
         <span class="lap">${formatLap(row.lap)}</span>
         <span class="gap">${gap}</span>
         <span class="when">${ago(row.at)}</span>`,
      ),
    );
  }
  box.append(list);
  return box;
}
