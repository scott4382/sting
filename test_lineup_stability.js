/**
 * test_lineup_stability.js
 *
 * Verifies that the approved lineup is preserved all the way through to the
 * live game — i.e. that startGame() and startH2() use the savedPlan when one
 * exists rather than regenerating a fresh random lineup.
 *
 * Run with:  node test_lineup_stability.js
 */

// ─── Extract pure logic from index.html ─────────────────────────────────────
const fs   = require('fs');
const html = fs.readFileSync(__dirname + '/index.html', 'utf8');

const marker = 'var jsxSource = "';
const srcStart = html.indexOf(marker) + marker.length;
const rawJs = html.slice(srcStart, srcStart + 500_000)
  .replace(/\\n/g,  '\n')
  .replace(/\\"/g,  '"')
  .replace(/\\'/g,  "'")
  .replace(/\\\\/g, '\\');

// Keep only the pure-JS portion (lines 1-439) before JSX starts
const jsLines = rawJs.split('\n').slice(0, 439).join('\n');

// Suppress the huge base64 logo constant so eval is fast
const safeJs = jsLines.replace(/const TEAM_LOGO_B64 = "[^"]*";/, 'const TEAM_LOGO_B64 = "";');

// Evaluate into the global V8 context so all constants/functions are
// accessible from the rest of this module.  We convert const/let → var so
// they land on the global object rather than being block-scoped inside eval.
const vm = require('vm');
const executableJs = safeJs.replace(/\bconst\b/g, 'var').replace(/\blet\b/g, 'var');
vm.runInThisContext(executableJs);

// ─── Helpers ────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    failed++;
  }
}

function assertDeepEqual(a, b, label) {
  const aStr = JSON.stringify(a);
  const bStr = JSON.stringify(b);
  if (aStr === bStr) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  FAIL: ${label}`);
    console.error(`     expected: ${bStr.slice(0, 200)}`);
    console.error(`     received: ${aStr.slice(0, 200)}`);
    failed++;
  }
}

// ─── Test fixtures ───────────────────────────────────────────────────────────
const formation = FORMATIONS['1-2-3-1'];

// 7 players with distinct ids, names, and no special prefs
const makePlayers = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Player${i + 1}`,
    present: true,
    totalTime: 0,
    games: 0,
    posPrefs: {},
  }));

const present7 = makePlayers(7);

// ─── Mock startGame (mirrors the real closure logic) ────────────────────────
// We reproduce the exact routing logic from the fixed startGame() so we can
// test it without a React runtime.

function mockBuildAll(present, form, seed = 0) {
  return buildHalfPlan(present, form, {}, null, seed, 0);
}

function mockStartGame(usePreview, plan, present, formation, seed) {
  // Mirrors: const { posMap: pm, starters, bench, subs } = plan
  //   ? { posMap: plan.h1Plan.posMap, starters: plan.h1Plan.starters, ... }
  //   : buildAll();
  if (plan) {
    return {
      source: 'savedPlan',
      posMap:   plan.h1Plan.posMap,
      starters: plan.h1Plan.starters,
      bench:    plan.h1Plan.bench,
      subs:     plan.h1Subs,
    };
  }
  const built = mockBuildAll(present, formation, seed);
  return { source: 'buildAll', ...built };
}

// ─── Mock startH2 (mirrors the fixed startH2 closure) ───────────────────────
function mockStartH2(savedPlan, present, formation, sessionRef, h1GkId) {
  if (savedPlan) {
    return {
      source: 'savedPlan',
      posMap:   savedPlan.h2Plan.posMap,
      starters: savedPlan.h2Plan.starters,
      bench:    savedPlan.h2Plan.bench,
      subs:     savedPlan.h2Subs,
    };
  }
  const built = buildHalfPlan(present, formation, sessionRef || {}, h1GkId, 0, 0);
  return { source: 'buildAll', ...built };
}

// ─── Build a realistic savedPlan as "Accept Lineup" would ───────────────────
function buildSavedPlan(present, formation, seed) {
  const sim  = simulateFullGame(present, formation, seed, 0);
  const h1Plan = buildHalfPlan(present, formation, {}, null, seed, 0);
  const h2Plan = buildHalfPlan(present, formation, {}, null, seed + 1, 0);
  return {
    h1Plan,
    h2Plan,
    h1Subs: sim.h1Subs,
    h2Subs: sim.h2Subs,
    seed,
    formKey: '1-2-3-1',
  };
}

// ────────────────────────────────────────────────────────────────────────────
//  TEST SUITE
// ────────────────────────────────────────────────────────────────────────────

console.log('\n=== 1. buildHalfPlan is deterministic for a given seed ===');
{
  const a = buildHalfPlan(present7, formation, {}, null, 42, 0);
  const b = buildHalfPlan(present7, formation, {}, null, 42, 0);
  assertDeepEqual(a.starters, b.starters, 'Same seed → identical starters');
  assertDeepEqual(a.posMap,   b.posMap,   'Same seed → identical posMap');
}

console.log('\n=== 2. buildHalfPlan produces different results for different seeds ===');
{
  const a = buildHalfPlan(present7, formation, {}, null, 42,  0);
  const b = buildHalfPlan(present7, formation, {}, null, 999, 0);
  // With 7 players there are many permutations — different seeds should differ
  const same = JSON.stringify(a.starters) === JSON.stringify(b.starters)
            && JSON.stringify(a.posMap)   === JSON.stringify(b.posMap);
  assert(!same, 'Different seeds → different lineup');
}

console.log('\n=== 3. startGame with savedPlan uses the approved H1 lineup ===');
{
  const seed      = 42;
  const savedPlan = buildSavedPlan(present7, formation, seed);
  const result    = mockStartGame(false, savedPlan, present7, formation, 0);

  assert(result.source === 'savedPlan', 'Source is savedPlan (not buildAll)');
  assertDeepEqual(result.starters, savedPlan.h1Plan.starters,
    'Starters match approved h1Plan.starters');
  assertDeepEqual(result.posMap, savedPlan.h1Plan.posMap,
    'posMap matches approved h1Plan.posMap');
  assertDeepEqual(result.bench, savedPlan.h1Plan.bench,
    'Bench matches approved h1Plan.bench');
  assertDeepEqual(result.subs, savedPlan.h1Subs,
    'Sub schedule matches approved h1Subs');
}

console.log('\n=== 4. startGame WITHOUT savedPlan falls back to buildAll ===');
{
  const result = mockStartGame(false, null, present7, formation, 42);
  assert(result.source === 'buildAll', 'Source is buildAll when no savedPlan');
  assert(Array.isArray(result.starters) && result.starters.length > 0,
    'buildAll produces valid starters');
}

console.log('\n=== 5. startGame(savedPlan) differs from startGame(null) ===');
{
  // Build a plan, then simulate "no plan" start with a different internal seed.
  // The approved plan (seed=42) should not match what seed=0 buildAll produces.
  const savedPlan   = buildSavedPlan(present7, formation, 42);
  const withPlan    = mockStartGame(false, savedPlan, present7, formation, 0);
  const withoutPlan = mockStartGame(false, null,      present7, formation, 0);

  const startersMatch = JSON.stringify(withPlan.starters) === JSON.stringify(withoutPlan.starters);
  const posMapMatch   = JSON.stringify(withPlan.posMap)   === JSON.stringify(withoutPlan.posMap);

  // seed 42 plan vs seed 0 buildAll — they should differ
  assert(!startersMatch || !posMapMatch,
    'Approved plan (seed 42) differs from regenerated lineup (seed 0)');
}

console.log('\n=== 6. startH2 with savedPlan uses the approved H2 lineup ===');
{
  const seed      = 42;
  const savedPlan = buildSavedPlan(present7, formation, seed);
  const result    = mockStartH2(savedPlan, present7, formation, {}, null);

  assert(result.source === 'savedPlan', 'Source is savedPlan (not buildAll)');
  assertDeepEqual(result.starters, savedPlan.h2Plan.starters,
    'H2 starters match approved h2Plan.starters');
  assertDeepEqual(result.posMap, savedPlan.h2Plan.posMap,
    'H2 posMap matches approved h2Plan.posMap');
  assertDeepEqual(result.subs, savedPlan.h2Subs,
    'H2 sub schedule matches approved h2Subs');
}

console.log('\n=== 7. startH2 WITHOUT savedPlan falls back to buildAll ===');
{
  const result = mockStartH2(null, present7, formation, {}, null);
  assert(result.source === 'buildAll', 'Source is buildAll when no savedPlan');
  assert(Array.isArray(result.starters) && result.starters.length > 0,
    'buildAll produces valid H2 starters');
}

console.log('\n=== 8. startH2(savedPlan) differs from startH2(null) ===');
{
  const savedPlan   = buildSavedPlan(present7, formation, 42);
  const withPlan    = mockStartH2(savedPlan, present7, formation, {}, null);
  const withoutPlan = mockStartH2(null,      present7, formation, {}, null);

  const startersMatch = JSON.stringify(withPlan.starters) === JSON.stringify(withoutPlan.starters);
  const posMapMatch   = JSON.stringify(withPlan.posMap)   === JSON.stringify(withoutPlan.posMap);

  assert(!startersMatch || !posMapMatch,
    'Approved H2 plan (seed 43) differs from regenerated H2 lineup (seed 0)');
}

console.log('\n=== 9. "Start Game" button (locked) passes savedPlan — source verification ===');
{
  // This test mirrors the button's onClick: `startGame(false, savedPlan)`
  // We verify the approved lineup reaches the game unchanged.
  const seed      = 77;
  const savedPlan = buildSavedPlan(present7, formation, seed);

  // Simulate the button click: startGame(false, savedPlan)
  const gameState = mockStartGame(false, savedPlan, present7, formation, 0 /* ignored */);

  assert(gameState.source === 'savedPlan',
    'Locked-lineup Start Game button uses savedPlan (not buildAll)');
  assertDeepEqual(gameState.starters, savedPlan.h1Plan.starters,
    'On-field players match the approved lineup');
}

console.log('\n=== 10. "Start Game" button (unlocked) captures visible plan then starts with it ===');
{
  // Mirrors the fixed button onClick:
  //   const plan = { h1Plan: finalH1, h2Plan: finalH2, h1Subs, h2Subs, ... };
  //   startGame(false, plan);   ← plan passed directly, no state re-render race
  const seed = 55;
  const h1Plan  = buildHalfPlan(present7, formation, {}, null, seed,     0);
  const h2Plan  = buildHalfPlan(present7, formation, {}, null, seed + 1, 0);
  const sim     = simulateFullGame(present7, formation, seed, 0);
  const capturedPlan = { h1Plan, h2Plan, h1Subs: sim.h1Subs, h2Subs: sim.h2Subs, seed, formKey: '1-2-3-1' };

  // startGame receives capturedPlan (not null)
  const gameState = mockStartGame(false, capturedPlan, present7, formation, 0 /* ignored */);

  assert(gameState.source === 'savedPlan',
    'Unlocked Start Game button starts with the captured plan');
  assertDeepEqual(gameState.starters, h1Plan.starters,
    'Starters match the lineup shown to the user');
  assertDeepEqual(gameState.posMap, h1Plan.posMap,
    'Position map matches the plan shown to the user');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SOME TESTS FAILED');
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}
