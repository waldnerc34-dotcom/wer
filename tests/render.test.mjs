/**
 * The rendering settings, checked without a GPU.
 *
 * Two things are worth asserting away from a browser: that the quality
 * presets are a ladder rather than a pile of numbers, and that the dynamic
 * resolution controller does what it claims — comes down under load, goes
 * back up when there is room, respects its bounds, and does not oscillate.
 *
 *   node tests/render.test.mjs
 */

import { QUALITY } from '../src/render/Renderer.js';
import { ResolutionScaler } from '../src/render/Resolution.js';

let failures = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✖'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

/* ------------------------------------------------------------- the ladder */

const TIERS = ['mobile', 'low', 'medium', 'high', 'ultra'];
console.log('\n=== quality presets ===');

check('every tier exists', TIERS.every((t) => QUALITY[t]), Object.keys(QUALITY).join(', '));

// Each rung must be at least as good as the one below it on every axis that
// has an obvious direction. Anything else is a preset someone would pick and
// get less for.
const RISING = ['shadowMapSize', 'cascades', 'shadowDistance', 'anisotropy', 'sceneryDensity'];
for (const field of RISING) {
  let ok = true;
  const values = TIERS.map((t) => QUALITY[t][field]);
  for (let i = 1; i < values.length; i++) {
    if (values[i] !== undefined && values[i - 1] !== undefined && values[i] < values[i - 1]) ok = false;
  }
  check(`${field} never falls as the tier rises`, ok, values.join(' → '));
}

const effectsOn = (t) => ['ao', 'bloom', 'motionBlur', 'smaa'].filter((k) => QUALITY[t][k]).length;
check('mobile spends nothing on post', QUALITY.mobile.post === false && effectsOn('mobile') === 0);
check('quality and ultra run the full post chain', effectsOn('high') === 4 && effectsOn('ultra') === 4);

console.log('\n=== reflections ===');
check('ray tracing is off below Quality', !QUALITY.mobile.reflections && !QUALITY.low.reflections && !QUALITY.medium.reflections);
check('Quality ray traces', Boolean(QUALITY.high.reflections), `${QUALITY.high.reflections.steps} steps`);
check(
  'Ultra ray traces further and finer',
  QUALITY.ultra.reflections.steps > QUALITY.high.reflections.steps &&
    QUALITY.ultra.reflections.maxDistance > QUALITY.high.reflections.maxDistance &&
    QUALITY.ultra.reflections.normalScale >= QUALITY.high.reflections.normalScale,
  `${QUALITY.ultra.reflections.steps} steps, ${QUALITY.ultra.reflections.maxDistance} m`,
);

console.log('\n=== 4K ===');
// A 1080p display: the preset must ask for a frame buffer 3840 across.
const bufferWidth = (preset, cssWidth, devicePixelRatio) => {
  const dpr = Math.min(devicePixelRatio, preset.pixelRatio);
  let scale = preset.renderScale ?? 1;
  if (preset.superSampleTo) {
    const needed = preset.superSampleTo / Math.max(1, cssWidth * dpr);
    scale = Math.min(Math.max(scale, needed), preset.maxRenderScale ?? 2);
  }
  return Math.round(cssWidth * dpr * scale);
};
check('Ultra renders 4K on a 1080p screen', bufferWidth(QUALITY.ultra, 1920, 1) === 3840, `${bufferWidth(QUALITY.ultra, 1920, 1)} px across`);
check('Ultra renders past 4K on a 4K screen', bufferWidth(QUALITY.ultra, 3840, 1) >= 4800, `${bufferWidth(QUALITY.ultra, 3840, 1)} px across`);
check('Ultra never runs away on a retina laptop', bufferWidth(QUALITY.ultra, 1512, 2) <= 6100, `${bufferWidth(QUALITY.ultra, 1512, 2)} px across`);
check('Quality stays at the display resolution', bufferWidth(QUALITY.high, 1920, 1) === 1920);

/* --------------------------------------------------- dynamic resolution */

console.log('\n=== dynamic resolution ===');

/** Runs `frames` frames at a fixed frame time and returns the final scale. */
const run = (scaler, fps, frames) => {
  for (let i = 0; i < frames; i++) scaler.frame(1 / fps);
  return scaler.scale;
};

let scaler = new ResolutionScaler({ target: 60, min: 0.62, max: 1, window: 30 });
check('starts at full resolution', scaler.scale === 1);

const under = run(scaler, 30, 300);
check('drops the resolution when frames are slow', under < 0.8, `scale ${under.toFixed(2)} at 30 fps`);
check('never drops below its floor', under >= 0.62, `floor 0.62`);

const recovered = run(scaler, 144, 600);
check('takes the pixels back when there is room', recovered > under + 0.15, `${under.toFixed(2)} → ${recovered.toFixed(2)}`);
check('never exceeds the preset', recovered <= 1, `scale ${recovered.toFixed(2)}`);

// Sitting exactly on the target must not sawtooth: a frame rate inside the
// dead band should leave the resolution alone.
scaler = new ResolutionScaler({ target: 60, min: 0.62, max: 1, window: 30 });
const changesBefore = scaler.changes;
run(scaler, 60, 600);
check('holds steady at the target', scaler.changes === changesBefore, `${scaler.changes} change(s) over 600 frames`);

// One long hitch — a shader compiling, a tab coming back — is not evidence.
scaler = new ResolutionScaler({ target: 60, min: 0.62, max: 1, window: 30 });
for (let i = 0; i < 300; i++) scaler.frame(i % 60 === 0 ? 1.2 : 1 / 62);
check('ignores a single long hitch', scaler.scale === 1, `scale ${scaler.scale.toFixed(2)}`);

scaler = new ResolutionScaler({ target: 60, min: 0.62, max: 1, window: 30 });
scaler.setEnabled(false);
run(scaler, 10, 300);
check('does nothing when switched off', scaler.scale === 1);

// A correction should land in roughly one move: cost goes with the pixel
// count, so halving the frame rate should take about a third off the scale,
// not creep there over a minute.
scaler = new ResolutionScaler({ target: 60, min: 0.3, max: 1, window: 30 });
run(scaler, 30, 60);
check('corrects in one window, not by creeping', scaler.scale <= 0.82, `scale ${scaler.scale.toFixed(2)} after 2 windows`);

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ all checks passed');
process.exit(failures ? 1 : 0);
