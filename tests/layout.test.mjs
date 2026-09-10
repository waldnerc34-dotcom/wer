/**
 * The front end's breakpoints, checked against real screens.
 *
 * A phone held sideways — the way this game is meant to be held — is not a
 * narrow screen. An iPhone Pro Max is 932 CSS px across in landscape, wider
 * than a 900 px "mobile" breakpoint, which once left it on the desktop
 * layout: two columns squeezed onto a 430 px-tall screen with the start
 * button off the edge. So the compact layout is asserted here against the
 * viewports it has to serve, rather than against a number someone typed.
 *
 *   node tests/layout.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSS = readFileSync(join(ROOT, 'src/ui/style.css'), 'utf8');

/** CSS viewports, in CSS pixels, that the compact layout must cover. */
const COMPACT = [
  ['iPhone SE, landscape', 667, 375],
  ['iPhone 13 mini, landscape', 812, 375],
  ['iPhone 14/15/16, landscape', 844, 390],
  ['iPhone 16 Pro, landscape', 874, 402],
  ['iPhone 14/15 Pro Max, landscape', 932, 430],
  ['iPhone 16 Pro Max, landscape', 956, 440],
  ['iPhone 14, portrait', 390, 844],
  ['iPad mini, portrait', 744, 1133],
  ['a short desktop window', 1400, 480],
];

/** Viewports that must keep the full two-column layout. */
const WIDE = [
  ['laptop', 1440, 900],
  ['desktop', 1920, 1080],
  ['iPad Pro, landscape', 1366, 1024],
];

/**
 * Evaluates a CSS media condition of the kind this stylesheet uses:
 * `max-width` / `min-width` / `max-height` / `min-height` features, joined
 * by `and`, with `,` between alternatives.
 */
function matches(condition, width, height) {
  return condition.split(',').some((alternative) =>
    alternative.split(/\band\b/).every((term) => {
      const m = /\(\s*(min|max)-(width|height)\s*:\s*([\d.]+)px\s*\)/.exec(term);
      if (!m) throw new Error(`unsupported media feature: ${term.trim()}`);
      const [, bound, axis, value] = m;
      const actual = axis === 'width' ? width : height;
      return bound === 'max' ? actual <= +value : actual >= +value;
    }),
  );
}

/** The condition of the media block that collapses the start screen to one column. */
function compactCondition() {
  const re = /@media([^{]+)\{/g;
  let m;
  while ((m = re.exec(CSS))) {
    // Walk to the end of this block, counting braces.
    let depth = 1;
    let i = re.lastIndex;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
    }
    const body = CSS.slice(re.lastIndex, i);
    if (/\.start\s*\{[^}]*grid-template-columns:\s*1fr/.test(body)) return m[1].trim();
  }
  throw new Error('no media block collapses .start to a single column');
}

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const condition = compactCondition();
console.log(`\n=== compact layout: @media ${condition} ===`);

for (const [name, w, h] of COMPACT) {
  check(`${name} gets the compact layout`, matches(condition, w, h), `${w}×${h}`);
}
for (const [name, w, h] of WIDE) {
  check(`${name} keeps both columns`, !matches(condition, w, h), `${w}×${h}`);
}

console.log('\n=== card rows ===');
const cardRow = /\.choices\.cards[^{]*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
// Stretching cards to the tallest in the row leaves slack that a <button>
// centres, which shows up as a black band above the photograph.
check('cards keep their own height', /align-items:\s*flex-start/.test(cardRow));

const carImage = /\.choice\.car img\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
check('car photographs hold 16:9', /aspect-ratio:\s*16\s*\/\s*9/.test(carImage));
check('car photographs are never stretched', /object-fit:\s*cover/.test(carImage));

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
