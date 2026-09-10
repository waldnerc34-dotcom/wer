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
check('quality and ultra run the full post chain', effectsOn('high') === 4 && effectsOn('ultra') === 4);

// A phone gets a picture, not a placeholder. The chain it runs is the cheap
// half of the list — tone mapping, bloom and haze all merge into one
// full-screen pass — and pointedly not the expensive half: ambient occlusion
// is its own pass, reflections need a second run over the geometry, and
// motion blur is seven texture reads a pixel.
check(
  'the phone tier renders a picture rather than a placeholder',
  QUALITY.mobile.post !== false && QUALITY.mobile.bloom && Boolean(QUALITY.mobile.atmosphere),
);
check(
  'and buys it without the passes a phone cannot afford',
  !QUALITY.mobile.ao && !QUALITY.mobile.reflections && !QUALITY.mobile.motionBlur,
);
check(
  'every tier is anti-aliased, one way or the other',
  TIERS.every((t) => QUALITY[t].smaa || QUALITY[t].msaa),
  TIERS.map((t) => (QUALITY[t].smaa ? 'SMAA' : `${QUALITY[t].msaa}× MSAA`)).join(' · '),
);
check(
  'the phone tier caps what it will ever be asked to draw',
  QUALITY.mobile.maxPixels > 0 && QUALITY.mobile.maxPixels <= 3.5e6,
  `${(QUALITY.mobile.maxPixels / 1e6).toFixed(1)} megapixels`,
);
check(
  'and can give up more resolution, faster, than any other tier',
  TIERS.every((t) => t === 'mobile' || QUALITY.mobile.minScale <= QUALITY[t].minScale) &&
    QUALITY.mobile.scalerWindow < 30,
  `floor ${QUALITY.mobile.minScale}, decides every ${QUALITY.mobile.scalerWindow} frames`,
);

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

console.log('\n=== 4K, and what it may cost ===');

// Mirrors Renderer#nativeRatio and #ceilingRatio: what the preset draws
// before the scaler has climbed, and the most it may ever draw.
const nativeRatio = (preset, devicePixelRatio) =>
  Math.min(devicePixelRatio, preset.pixelRatio) * (preset.renderScale ?? 1);

const ceilingRatio = (preset, cssWidth, cssHeight, devicePixelRatio) => {
  const native = nativeRatio(preset, devicePixelRatio);
  let ratio = native;
  if (preset.superSampleTo) {
    ratio = Math.max(native, preset.superSampleTo / Math.max(1, cssWidth));
    ratio = Math.min(ratio, native * (preset.maxRenderScale ?? 2));
  }
  if (preset.maxPixels) {
    ratio = Math.min(ratio, Math.sqrt(preset.maxPixels / Math.max(1, cssWidth * cssHeight)));
  }
  return ratio;
};

const width = (ratio, cssWidth) => Math.round(cssWidth * ratio);
const megapixels = (ratio, w, h) => (w * ratio * h * ratio) / 1e6;

// The black-screen fix: nothing supersampled is allocated up front. The
// first frame is the display's own resolution and the scaler climbs from
// there only while frames stay inside budget — a GPU that cannot afford
// half a gigabyte of 4K buffers never asks for them.
check(
  'Ultra starts at the display resolution',
  width(nativeRatio(QUALITY.ultra, 1), 1920) === 1920,
  `${width(nativeRatio(QUALITY.ultra, 1), 1920)} px across on the first frame`,
);

check(
  'Ultra may climb to 4K on a 1080p screen',
  width(ceilingRatio(QUALITY.ultra, 1920, 1080, 1), 1920) === 3840,
  `${width(ceilingRatio(QUALITY.ultra, 1920, 1080, 1), 1920)} px across`,
);

for (const [name, w, h, dpr] of [
  ['1080p', 1920, 1080, 1],
  ['1440p', 2560, 1440, 1],
  ['4K', 3840, 2160, 1],
  ['a retina laptop', 1512, 982, 2],
  ['an ultrawide', 3440, 1440, 1],
]) {
  const mp = megapixels(ceilingRatio(QUALITY.ultra, w, h, dpr), w, h);
  check(`Ultra stays inside its budget on ${name}`, mp <= 8.4 + 0.01, `${mp.toFixed(1)} megapixels`);
}

for (const [name, w, h, dpr] of [
  ['a phone', 390, 844, 3],
  ['a big phone', 430, 932, 3],
  ['a tablet', 1366, 1024, 2],
]) {
  const mp = megapixels(ceilingRatio(QUALITY.mobile, w, h, dpr), w, h);
  check(`the phone tier stays inside its budget on ${name}`, mp <= 3.2 + 0.01, `${mp.toFixed(2)} megapixels`);
}

check('Quality stays at the display resolution', width(nativeRatio(QUALITY.high, 1), 1920) === 1920);
check('Quality never supersamples', !QUALITY.high.superSampleTo);

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
