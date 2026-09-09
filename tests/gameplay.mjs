import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = html.match(/<script id="gameplay-core">([\s\S]*?)<\/script>/)?.[1];
assert.ok(source, "Production gameplay core must be embedded in the shipped HTML");
const context = vm.createContext({});
vm.runInContext(source, context);
const game = context.RainbowRun;
const plain = value => JSON.parse(JSON.stringify(value));
const seeded = seed => () => ((seed = Math.imul(seed, 1664525) + 1013904223 >>> 0) / 2 ** 32);

test("new runs reset all gameplay and route state without reusing rows", () => {
  const run = game.createRun(seeded(1));
  for (let i = 0; i < 20; i++) game.resolve(run, run.target, .1);
  game.resolve(run, null, 1);
  const fresh = game.createRun(seeded(1));
  assert.deepEqual(
    [fresh.phase, fresh.score, fresh.multiplier, fresh.hearts, fresh.target, fresh.rainbows, fresh.chain, fresh.perfects],
    ["playing", 0, 1, 3, 0, 0, 0, 0]
  );
  assert.equal(fresh.speed, 22);
  assert.equal(fresh.spacing, 24);
  assert.equal(fresh.recovery, 0);
  assert.deepEqual(plain(fresh.rows.map(row => row.z)), [-18, -42, -66, -90]);
  assert.notEqual(fresh.rows[0], run.rows[0]);
  assert.ok(fresh.rows.every(row => !row.crossed));
});

test("precision uses the pre-increment multiplier; every third perfect earns 300", () => {
  const run = game.createRun();
  const events = Array.from({length: 6}, () => game.resolve(run, run.target, .4));
  assert.deepEqual(events.map(event => event.points), [150, 300, 750, 600, 750, 1200]);
  assert.equal(run.score, 3750);
  assert.equal(run.multiplier, 7);
  assert.equal(run.perfects, 6);
  assert.equal(run.chain, 6);
  assert.equal(run.rainbows, 1);
  assert.equal(run.target, 0);
  assert.equal(run.speed, 23);
  assert.equal(run.spacing, 23.6);
  assert.ok(events[5].rainbow && events[5].chainBonus);
});

test("ordinary hits break only the perfect chain; wrong/miss retain the target", () => {
  const run = game.createRun();
  game.resolve(run, 0, .4);
  const normal = game.resolve(run, 1, .400001);
  assert.equal(normal.kind, "correct");
  assert.equal(normal.points, 200);
  assert.equal(run.chain, 0);
  assert.equal(run.multiplier, 3);
  assert.equal(run.perfects, 1);
  for (const color of [5, null]) {
    const score = run.score;
    const result = game.resolve(run, color, .1);
    assert.equal(result.kind, color === null ? "miss" : "wrong");
    assert.equal(run.target, 2);
    assert.equal(run.multiplier, 1);
    assert.equal(run.chain, 0);
    assert.equal(run.score, score);
  }
  assert.equal(run.hearts, 1);
  assert.equal(game.resolve(run, null, 1).over, true);
  assert.equal(run.phase, "over");
  assert.equal(game.resolve(run, 2, 0), null);
  assert.equal(run.hearts, 0);
});

function crossingRun(z = -.11) {
  const run = game.createRun(seeded(8));
  run.rows = [{...run.rows[0], z, rings: [{color: 0, x: 0, y: 0}]}];
  return run;
}

test("crossings interpolate steering and score each row exactly once", () => {
  const run = crossingRun();
  const events = game.advance(run, .01, {x: -2, y: 0}, {x: 2, y: 0});
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "perfect");
  assert.equal(run.score, 150);
  assert.equal(game.advance(run, .01, {x: 0, y: 0}, {x: 0, y: 0}).length, 0);
  const boundary = crossingRun(0);
  assert.equal(game.advance(boundary, .01, {x: 0, y: 0}, {x: 3, y: 0})[0].kind, "perfect");
});

test("collision radius remains strictly below one; empty space costs a heart", () => {
  for (const [distance, kind] of [[.4, "perfect"], [.401, "correct"], [.999, "correct"], [1, "miss"], [3, "miss"]]) {
    const run = crossingRun();
    const point = {x: distance, y: 0};
    assert.equal(game.advance(run, .01, point, point)[0].kind, kind);
    assert.equal(run.hearts, kind === "miss" ? 2 : 3);
  }
});

test("crossing interpolation respects a recovery-speed change within the frame", () => {
  const run = crossingRun(-.22 * .65 - .22);
  run.recovery = .01;
  // Crossing is at 20ms of a 30ms frame: one slow segment, then one full-speed segment.
  const events = game.advance(run, .03, {x: -2, y: 0}, {x: 1, y: 0});
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "perfect");
  assert.equal(run.recovery, 0);
});

test("crossings resolve chronologically, stop at death, and never score afterward", () => {
  const run = crossingRun();
  run.rows = [-.4, -.3, -.2, -.1].map(z => ({z, crossed: false, rings: []}));
  run.rows[0].rings = [{color: 0, x: 0, y: 0}];
  const point = {x: 0, y: 0};
  const events = game.advance(run, .05, point, point);
  assert.equal(events.length, 3);
  assert.equal(run.phase, "over");
  assert.equal(run.score, 0);
  assert.equal(run.hearts, 0);
  const snapshot = JSON.stringify(run);
  assert.equal(game.advance(run, 1, point, point).length, 0);
  assert.equal(JSON.stringify(run), snapshot);
});

test("recycled rows use bounded difficulty and stay in chronological order", () => {
  const run = game.createRun(seeded(12));
  for (let i = 0; i < 200; i++) game.resolve(run, run.target, .5);
  assert.equal(run.speed, 28);
  assert.equal(run.spacing, 22.4);
  run.rows[0].z = 8;
  run.rows[0].crossed = true;
  const farthest = Math.min(...run.rows.map(row => row.z));
  game.advance(run, 0, {x: 0, y: 0}, {x: 0, y: 0});
  assert.equal(run.rows[0].z, farthest - 22.4);
  assert.equal(run.rows[0].crossed, false);
});

test("best score validation and storage failures are explicit and nonfatal", () => {
  const warnings = [];
  const warn = message => warnings.push(message);
  for (const value of [null, "0", "150", String(Number.MAX_SAFE_INTEGER)]) {
    assert.equal(game.loadBest(() => ({getItem: () => value}), warn), Number(value));
  }
  assert.equal(warnings.length, 0);
  for (const value of ["", "-1", "3.2", "NaN", "Infinity", "9007199254740992", " 3", "1e3", "{}"]) {
    const before = warnings.length;
    assert.equal(game.loadBest(() => ({getItem: () => value}), warn), 0);
    assert.equal(warnings.length, before + 1);
  }
  const blocked = () => { throw new Error("blocked"); };
  assert.equal(game.loadBest(blocked, warn), 0);
  assert.equal(game.saveBest(100, blocked, warn), false);
  assert.equal(game.saveBest(100, () => ({setItem: blocked}), warn), false);
  assert.equal(game.saveBest(-1, () => ({}), warn), false);
  let saved;
  assert.equal(game.saveBest(350, () => ({setItem: (key, value) => { saved = [key, value]; }}), warn), true);
  assert.deepEqual(saved, [game.bestKey, "350"]);
  assert.ok(warnings.every(message => message.startsWith("Best score")));
});

test("Space only starts/replays on a fresh press; steering is bounded and opposing keys cancel", () => {
  for (const phase of ["menu", "over"]) {
    assert.equal(game.shouldStart(phase, "Space", false), true);
    assert.equal(game.shouldStart(phase, "Space", true), false);
  }
  assert.equal(game.shouldStart("playing", "Space", false), false);
  assert.equal(game.shouldStart("over", "KeyA", false), false);
  const input = {x: 0, y: 0};
  let position = {x: 0, y: 0};
  for (let i = 0; i < 200; i++) position = game.steer(position, input, {KeyD: true, KeyW: true}, 1 / 60);
  assert.equal(input.x, 1); assert.equal(input.y, 1);
  assert.ok(position.x <= 4.2 && position.x > 4.19);
  assert.ok(position.y <= 3.4 && position.y > 3.39);
  game.steer(position, input, {KeyA: true, KeyD: true, KeyW: true, KeyS: true}, .1);
  assert.deepEqual(input, {x: 1, y: 1});
});

function keysToward(point, input, dt) {
  const dx = point.x / 4.2 - input.x, dy = point.y / 3.4 - input.y;
  return {
    KeyA: dx < -dt, KeyD: dx > dt,
    KeyS: dy < -dt, KeyW: dy > dt
  };
}

test("generated layouts keep exact centers, safe bounds, and smooth route transitions", () => {
  const directions = new Set(), radii = new Set();
  for (let seed = 1; seed <= 50; seed++) {
    const run = game.createRun(seeded(seed * 19937));
    directions.add(run.direction);
    let previous = run.rows.at(-1);
    for (let index = 0; index < 180; index++) {
      const row = game.makeRow(run, -24);
      assert.ok(Math.abs(row.phase - previous.phase) <= .08000001);
      assert.ok(row.radius >= 2.1 && row.radius <= 2.5);
      assert.ok(Math.abs(row.x) <= .25 && Math.abs(row.y) <= .25);
      assert.deepEqual(plain(row.rings.map(ring => ring.color)), [0, 1, 2, 3, 4, 5]);
      for (const ring of row.rings) {
        assert.ok(Math.abs(ring.x) < 2.76 && Math.abs(ring.y) < 2.76);
        assert.ok(Math.abs(Math.hypot(ring.x - row.x, ring.y - row.y) - row.radius) < 1e-10);
      }
      radii.add(row.radius.toFixed(1));
      previous = row;
    }
  }
  assert.equal(directions.size, 2);
  assert.ok(radii.has("2.1") && radii.has("2.5"));
});

for (const hz of [30, 60, 120]) {
  test(`actual keyboard smoothing reaches 240 consecutive targets per seed at ${hz}Hz`, () => {
    for (let seed = 1; seed <= 12; seed++) {
      const run = game.createRun(seeded(seed * 19937));
      let position = {x: 0, y: 0}, input = {x: 0, y: 0}, collected = 0;
      const dt = 1 / hz;
      for (let frame = 0; frame < hz * 270 && collected < 240; frame++) {
        const row = run.rows.filter(row => !row.crossed).sort((a, b) => b.z - a.z)[0];
        const point = row.rings[run.target], previous = position;
        position = game.steer(position, input, keysToward(point, input, dt), dt);
        for (const event of game.advance(run, dt, previous, position)) {
          assert.ok(event.points > 0, `seed ${seed}, row ${collected}, ${event.kind}`);
          collected++;
        }
        assert.ok(run.spacing / run.speed >= .8 - 1e-10);
        assert.ok(run.spacing / run.speed <= 24 / 22);
      }
      assert.equal(collected, 240);
      assert.equal(run.hearts, 3);
      assert.equal(run.rainbows, 40);
    }
  });

  test(`next target remains reachable after any wrong color at maximum pace, ${hz}Hz`, () => {
    for (let seed = 1; seed <= 8; seed++) {
      const run = game.createRun(seeded(seed * 19937));
      for (let index = 0; index < 30; index++) {
        const row = game.makeRow(run, 0), next = game.makeRow(run, -22.4);
        for (let target = 0; target < 6; target++) {
          for (let wrong = 0; wrong < 6; wrong++) {
            let position = {x: row.rings[wrong].x, y: row.rings[wrong].y};
            const input = {x: position.x / 4.2, y: position.y / 3.4}, dt = 1 / hz;
            const state = game.createRun(seeded(1));
            state.speed = 28; state.spacing = 22.4; state.target = target;
            game.resolve(state, wrong === target ? null : wrong, 0);
            state.rows = [{...next, crossed: false}];
            let outcome;
            for (let frame = 0; frame < hz && !outcome; frame++) {
              const previous = position;
              position = game.steer(position, input, keysToward(next.rings[target], input, dt), dt);
              outcome = game.advance(state, dt, previous, position)[0];
            }
            assert.ok(outcome?.points > 0, `seed ${seed}, layout ${index}, ${wrong} -> ${target}: ${outcome?.kind}`);
          }
        }
      }
    }
  });

  test(`miss recovery reaches any target from all steering-limit corners at ${hz}Hz`, () => {
    for (let seed = 1; seed <= 8; seed++) {
      const run = game.createRun(seeded(seed * 19937));
      for (let index = 0; index < 36; index++) {
        const row = game.makeRow(run, -22.4);
        for (let target = 0; target < 6; target++) {
          for (const x of [-4.2, 4.2]) for (const y of [-3.4, 3.4]) {
            let position = {x, y};
            const input = {x: x / 4.2, y: y / 3.4}, dt = 1 / hz;
            const state = game.createRun(seeded(1));
            state.speed = 28; state.spacing = 22.4; state.target = target;
            game.resolve(state, null, 1);
            state.rows = [{...row, crossed: false}];
            let outcome;
            for (let frame = 0; frame < hz * 1.2 && !outcome; frame++) {
              const previous = position;
              position = game.steer(position, input, keysToward(row.rings[target], input, dt), dt);
              outcome = game.advance(state, dt, previous, position)[0];
            }
            assert.ok(outcome?.points > 0, `seed ${seed}, layout ${index}, corner ${x},${y}, target ${target}`);
            assert.equal(state.hearts, 2);
          }
        }
      }
    }
  });
}
