const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fractionAt, displayedFraction, displayedMedian, wrapLongitude, evaluate, makeQuestions} = require('./game.js');
const base = __dirname;
const context = {window: {}};
vm.runInNewContext(fs.readFileSync(path.join(base, 'data/bundle.js'), 'utf8'), context);
const datasets = context.window.GAME_DATA.datasets;
let assertions = 0;
function check(condition, message) {assert.ok(condition, message); assertions++;}
for (const id of ['bare_japan', 'building_world', 'builtup_japan', 'grassland_japan', 'water_japan', 'land_world', 'shrubland_japan', 'wetland_japan', 'ocean_world', 'rainperiod_01_01_world', 'rainperiod_03_01_world', 'rainperiod_06_01_world']) {
  check(datasets.some(data => data.id === id), 'new dataset included: ' + id);
}
const cover = datasets.filter(data => ['builtup','grassland','water','forest','cropland','shrubland','wetland','bare'].includes(data.metric));
check(cover.reduce((sum, data) => sum + data.total, 0) <= cover[0].validation.valid_area_km2 * 1e6, 'exclusive land classes within valid area');
const land = datasets.find(data => data.id === 'land_world');
const annual = datasets.find(data => data.id === 'rainfall_world');
const periods = datasets.filter(data => data.metric.startsWith('rainperiod_'));
check(periods.length === 18, '18 periods plus annual');
check(!datasets.some(data => ['rainwarm','raincold'].includes(data.metric)), 'old periods excluded');
for (const length of [1,3,6]) {
  const group = periods.filter(data => data.validation.months.length === length);
  check(group.length === 12 / length, 'period count');
  check(group.flatMap(data => data.validation.months).sort((a,b)=>a-b).join(',') === '1,2,3,4,5,6,7,8,9,10,11,12', 'each month once');
  for (const axis of ['longitude','latitude']) for (let i=0;i<annual[axis].distribution.length;i++) {
    const sum = group.reduce((total,data)=>total+data[axis].distribution[i],0);
    check(Math.abs(sum-annual[axis].distribution[i]) < Math.max(1,annual[axis].distribution[i]*1e-10), 'period sums equal annual distribution');
  }
}
for (const cut of land.validation.cuts) {
  check(Math.abs(fractionAt(land.longitude, cut.longitude) - cut.direct_area / land.total) < 1e-7, 'land direct polygon cut');
}
for (const data of datasets) {
  const full = JSON.parse(fs.readFileSync(path.join(base, 'data', data.id + '.json'), 'utf8'));
  for (const axisName of ['longitude', 'latitude']) {
    const axis = data[axisName], source = full[axisName];
    check(fractionAt(axis, -1000) === 0, data.id + ' lower edge');
    check(fractionAt(axis, 1000) === 1, data.id + ' upper edge');
    check(Math.abs(fractionAt(axis, axis.median) - .5) < 1e-6, data.id + ' exact median');
    check(evaluate(axis, axis.median).score === 1000, data.id + ' maximum score');
    check(evaluate(axis, axis.median).stars === 10, data.id + ' maximum stars');
    let prior = -1;
    for (let i = 0; i <= 120; i++) {
      const value = source.edges[0] + (source.edges.at(-1) - source.edges[0]) * i / 120;
      const actual = fractionAt(axis, value), expected = fractionAt(source, value);
      check(actual >= prior, data.id + ' monotonic CDF');
      check(Math.abs(actual - expected) < 1e-6, data.id + ' packed/source agreement');
      prior = actual;
    }
  }
}
for (const mode of ['japan', 'world', 'random']) {
  for (let seed = 1; seed <= 100; seed++) {
    let number = seed;
    const rng = () => ((number = (number * 1664525 + 1013904223) >>> 0) / 4294967296);
    const questions = makeQuestions(datasets, mode, rng);
    const size = datasets.filter(d => mode === 'random' || d.region === mode).length;
    check(questions.length === 5, 'five rounds');
    check(questions.every(q => mode === 'random' || q.data.region === mode), 'region selection');
    check(new Set(questions.slice(0, Math.min(5, size)).map(q => q.key)).size === Math.min(5, size), 'no premature duplicates');
    check(questions.every(q => datasets.includes(q.data)), 'only available data');
    check(questions.every(q => q.data.region === 'japan' || q.axis === 'longitude'), 'world longitude only');
    check(questions.every(q => Math.abs(displayedFraction(q.data[q.axis], q.answer, q.left) - .5) < 1e-7), 'correct axis median');
    check(questions.every(q => q.data.region !== 'japan' || q.left === undefined), 'Japan fixed');
    const worlds = questions.filter(q => q.data.region === 'world');
    check(new Set(worlds.map(q => q.center)).size === worlds.length, 'different world centers');
    check(worlds.every(q => Math.abs(displayedFraction(q.data.longitude, q.answer, q.left) - .5) < 1e-7), 'rotated answers');
  }
}
const uniform = {edges: [0, 100], cumulative: [0, 100]};
let rainFirst = 0;
for (let seed=1;seed<=1000;seed++) {
  let number=seed;
  const rng=()=>((number=(number*1664525+1013904223)>>>0)/4294967296);
  const questions=makeQuestions(datasets,'world',rng);
  if (questions[0].data.metric.startsWith('rain')) rainFirst++;
  check(questions.filter(q=>q.data.metric.startsWith('rain')).length<=3, 'rain periods do not dominate rounds');
}
check(rainFirst>100 && rainFirst<300, 'rain family has one share despite 19 periods');
let lastScore = 1001, lastStars = 11;
for (let error = 0; error <= 50; error += .01) {
  const result = evaluate(uniform, 50 + error);
  check(result.score <= lastScore && result.stars <= lastStars, 'monotonic score/stars');
  check(result.score >= 0 && result.score <= 1000, 'score bounds');
  lastScore = result.score; lastStars = result.stars;
}
check(evaluate(uniform, 60).score === 500, '10pp score anchor');
check(evaluate(uniform, 50.5).stars === 10, 'achievable 10 stars');
check(evaluate(uniform, 51).stars === 9, '9 stars anchor');
check(evaluate(uniform, 55).stars === 7, '7 stars anchor');
check(fractionAt({edges: [0, 1, 2, 3], cumulative: [0, 5, 5, 10]}, 1.5) === .5, 'zero-weight plateau');
for (const data of datasets.filter(d => d.region === 'world')) {
  const axis = data.longitude;
  for (const center of [-180, -165, -100, 0, 75, 135, 179.9]) {
    const left = center - 180;
    check(displayedFraction(axis, left, left) === 0, 'rotated left endpoint');
    check(Math.abs(displayedFraction(axis, left + 360, left) - 1) < 1e-10, 'rotated right endpoint');
    const median = displayedMedian(axis, left);
    check(evaluate(axis, median, left).score === 1000, 'rotated perfect score');
    check(Math.abs(displayedFraction(axis, median + 360, left + 360) - .5) < 1e-8, '360 degree invariance');
    for (const distance of [15.37, 89.9, 180, 270.1, 359.9]) {
      const value = left + distance;
      let direct = 0;
      for (let i = 0; i < axis.distribution.length; i++) {
        for (const shift of [-360, 0, 360]) {
          const a = axis.edges[i] + shift, b = axis.edges[i + 1] + shift;
          const overlap = Math.max(0, Math.min(b, value) - Math.max(a, left));
          direct += overlap / (b - a) * axis.distribution[i];
        }
      }
      direct /= axis.cumulative.at(-1);
      check(Math.abs(displayedFraction(axis, value, left) - direct) < 1e-8, data.id + ' direct rotated strip integration');
    }
  }
}
check(wrapLongitude(190) === -170 && wrapLongitude(-190) === 170, 'date line wrapping');
console.log(`PASS: ${assertions} assertions; ${datasets.length} real datasets; 300 complete question schedules.`);


