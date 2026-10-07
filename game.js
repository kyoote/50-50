/* 50:50 — source data and processing details are in DATA_SOURCES.md. */
(function (root) {
  'use strict';
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const SIGMA = 10 / Math.sqrt(2 * Math.log(2));
  function fractionAt(axis, value) {
    const {edges, cumulative} = axis;
    const total = cumulative[cumulative.length - 1];
    if (value <= edges[0]) return 0;
    if (value >= edges[edges.length - 1]) return 1;
    let lo = 0, hi = edges.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= value) lo = mid; else hi = mid;
    }
    const part = (value - edges[lo]) / (edges[hi] - edges[lo]);
    return clamp((cumulative[lo] + part * (cumulative[hi] - cumulative[lo])) / total, 0, 1);
  }
  const wrapLongitude = value => ((value + 180) % 360 + 360) % 360 - 180;
  function cyclicTotal(axis, value) {
    return Math.floor((value + 180) / 360) + fractionAt(axis, wrapLongitude(value));
  }
  function displayedFraction(axis, value, left) {
    if (left === undefined) return fractionAt(axis, value);
    return clamp(cyclicTotal(axis, clamp(value, left, left + 360)) - cyclicTotal(axis, left), 0, 1);
  }
  function displayedMedian(axis, left) {
    if (left === undefined) return axis.median;
    let lo = left, hi = left + 360;
    for (let i = 0; i < 55; i++) {
      const mid = (lo + hi) / 2;
      if (displayedFraction(axis, mid, left) < .5) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }
  function evaluate(axis, value, left) {
    const fraction = displayedFraction(axis, value, left);
    const error = Math.abs(fraction * 100 - 50);
    const score = Math.round(1000 * Math.exp(-(error * error) / (2 * SIGMA * SIGMA)));
    const thresholds = [.5, 1, 2, 5, 7.5, 10, 15, 20, 30, 40];
    const index = thresholds.findIndex(limit => error <= limit + 1e-10);
    return {fraction, error, score, stars: index < 0 ? 0 : 10 - index};
  }
  function makeQuestions(datasets, mode, rng = Math.random) {
    const pool = datasets.filter(d => mode === 'random' || d.region === mode)
      .map(data => ({data, axis: 'longitude', key: data.id}));
    if (!pool.length) throw new Error('このエリアに出題可能なデータがありません。');
    const result = [], used = new Set();
    const centers = [135, -100, 15, 75, -40, -165];
    for (let i = 0; i < 5; i++) {
      if (used.size === pool.length) used.clear();
      const previous = result[result.length - 1];
      const candidates = pool.filter(q => !used.has(q.key));
      const groups = new Map();
      for (const q of candidates) {
        const key = q.data.region + ':' + (q.data.metric.startsWith('rain') ? 'rain' : q.data.metric);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(q);
      }
      const choices = [...groups.values()].map(group => group[Math.floor(rng() * group.length)]);
      const ranked = choices.map(q => ({q, weight: rng() * 1.4 + (previous ?
        (q.data.metric.startsWith('rain') && previous.data.metric.startsWith('rain') ? 0 : q.data.metric !== previous.data.metric ? 3 : 0) +
        (mode === 'random' && q.data.region !== previous.data.region ? 2 : 0) : 0)}));
      ranked.sort((a, b) => b.weight - a.weight);
      const question = {...ranked[0].q};
      if (question.data.region === 'japan') question.axis = rng() < .5 ? 'longitude' : 'latitude';
      if (question.data.region === 'world') {
        const index = Math.floor(rng() * centers.length);
        question.center = Math.round(centers.splice(index, 1)[0] + rng() * 20 - 10);
        question.left = question.center - 180;
      }
      question.answer = displayedMedian(question.data[question.axis], question.left);
      result.push(question);
      used.add(question.key);
    }
    return result;
  }
  const api = {fractionAt, displayedFraction, displayedMedian, wrapLongitude, evaluate, makeQuestions, SIGMA};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.HalfEngine = api;
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  const payload = root.GAME_DATA;
  if (!payload || !payload.datasets.length || !payload.maps.world || !payload.maps.japan) {
    $('home-screen').hidden = true;
    $('load-error').hidden = false;
    return;
  }
  const regionNames = {world: '世界', japan: '日本'};
  const metricNames = {bare: '裸地・岩場', building: '建物被覆', shrubland: '低木地', wetland: '湿地', ocean: '海洋', population: '人口', rainfall: '降水', forest: '樹木被覆', cropland: '農地', builtup: '市街地', grassland: '草地', water: '水面', land: '陸地'};
  const state = {mode: 'random', questions: [], results: [], index: 0, value: 0, answered: false, screen: 'home-screen', view: null};
  for (const data of payload.datasets) if (data.metric.startsWith('rainperiod_')) metricNames[data.metric] = data.metadata.name.replace('に降る水の総量', 'の降水');
  const namespace = 'http://www.w3.org/2000/svg';
  const paths = new Map();
  function svgElement(name, attrs, text) {
    const element = document.createElementNS(namespace, name);
    for (const [key, value] of Object.entries(attrs || {})) element.setAttribute(key, value);
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function projectView(region, width, height, center = 0) {
    const bounds = region === 'world' ? [center - 180, -90, center + 180, 90] : [122, 23, 155, 46.5];
    const cos = region === 'world' ? 1 : Math.cos(36 * Math.PI / 180);
    const [west, south, east, north] = bounds;
    const scale = Math.min((width - 55) / ((east - west) * cos), (height - 75) / (north - south));
    const left = (width - (east - west) * cos * scale) / 2;
    const top = (height - (north - south) * scale) / 2;
    return {bounds, width, height, x: lon => left + (lon - west) * cos * scale,
      y: lat => top + (north - lat) * scale,
      lon: x => west + (x - left) / (cos * scale), lat: y => north - (y - top) / scale};
  }
  function geometryPath(geometry, view, offset = 0) {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.map(polygon => polygon.map(ring => ring.map((point, i) =>
      `${i ? 'L' : 'M'}${view.x(point[0] + offset).toFixed(2)},${view.y(point[1]).toFixed(2)}`).join('') + 'Z').join('')).join('');
  }
  function buildMap(container, region, hero = false, center = 0) {
    const width = hero ? 1000 : Math.max(360, container.clientWidth);
    const height = hero ? 420 : Math.max(230, container.clientHeight);
    const view = projectView(region, width, height, center);
    const svg = svgElement('svg', {viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true'});
    const defs = svgElement('defs');
    const clip = svgElement('clipPath', {id: hero ? 'hero-clip' : 'game-clip'});
    const [west, south, east, north] = view.bounds;
    clip.append(svgElement('rect', region === 'world' ?
      {x: view.x(west), y: view.y(north), width: view.x(east) - view.x(west), height: view.y(south) - view.y(north)} :
      {x: 6, y: 35, width: width - 12, height: height - 65}));
    defs.append(clip); svg.append(defs);
    const content = svgElement('g', {'clip-path': `url(#${hero ? 'hero-clip' : 'game-clip'})`});
    const step = region === 'world' ? 30 : 5;
    for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
      content.append(svgElement('line', {x1: view.x(lon), x2: view.x(lon), y1: view.y(north), y2: view.y(south), class: 'grid-line'}));
      if (!hero) {
        const label = wrapLongitude(lon);
        content.append(svgElement('text', {x: view.x(lon) + 4, y: Math.min(height - 38, view.y(south) - 4), class: 'grid-label'}, `${Math.abs(label)}°${label < 0 ? 'W' : 'E'}`));
      }
    }
    for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
      content.append(svgElement('line', {x1: view.x(west), x2: view.x(east), y1: view.y(lat), y2: view.y(lat), class: 'grid-line'}));
    }
    const key = `${region}/${width}/${height}/${center}`;
    if (!paths.has(key)) {
      const offsets = region === 'world' ? [-360, 0, 360] : [0];
      const list = offsets.flatMap(offset => payload.maps.world.features.map(feature => ({path: geometryPath(feature.geometry, view, offset), kind: region === 'world' ? 'land' : 'neighbor'})));
      if (region === 'japan') for (const feature of payload.maps.japan.features) list.push({path: geometryPath(feature.geometry, view), kind: 'land japan-land'});
      paths.set(key, list);
      if (paths.size > 8) paths.delete(paths.keys().next().value);
    }
    for (const item of paths.get(key)) content.append(svgElement('path', {d: item.path, class: item.kind, 'fill-rule': 'evenodd'}));
    if (region === 'japan') {
      for (const [name, lon, lat, dx, dy] of [['札幌', 141.3545, 43.0618, 8, -7], ['東京', 139.6917, 35.6895, 8, 8], ['大阪', 135.5023, 34.6937, -28, 16], ['那覇', 127.6809, 26.2124, 8, 5]]) {
        content.append(svgElement('circle', {cx: view.x(lon), cy: view.y(lat), r: 2, class: 'city-dot'}));
        content.append(svgElement('text', {x: view.x(lon) + dx, y: view.y(lat) + dy, class: 'city-label'}, name));
      }
    }
    if (hero) {
      content.append(svgElement('line', {x1: view.x(25), x2: view.x(25), y1: 22, y2: height - 20, class: 'answer-line', 'stroke-dasharray': '4 5'}));
      content.append(svgElement('circle', {cx: view.x(25), cy: view.y(12), r: 7, class: 'answer-handle'}));
    } else {
      content.append(svgElement('line', {id: 'correct-line', class: 'correct-line', visibility: 'hidden'}));
      content.append(svgElement('line', {id: 'answer-line', class: 'answer-line'}));
      content.append(svgElement('circle', {id: 'answer-handle', r: 6, class: 'answer-handle'}));
    }
    svg.append(content); container.replaceChildren(svg);
    return view;
  }
  function coordinate(value, axis, digits = 2) {
    if (axis === 'longitude') value = wrapLongitude(value);
    const direction = axis === 'longitude' ? (value < 0 ? '西経' : '東経') : (value < 0 ? '南緯' : '北緯');
    return `${direction} ${Math.abs(value).toFixed(digits)}°`;
  }
  function starsMarkup(count) {
    return '★'.repeat(count) + `<span class="empty">${'☆'.repeat(10 - count)}</span>`;
  }
  function showScreen(id) {
    for (const name of ['home-screen', 'game-screen', 'final-screen']) $(name).hidden = name !== id;
    state.screen = id;
    window.scrollTo({top: 0, behavior: 'instant'});
  }
  function updatePool() {
    const data = payload.datasets.filter(d => state.mode === 'random' || d.region === state.mode);
    const names = [...new Set(data.map(d => d.metric.startsWith('rain') ? '降水' : metricNames[d.metric]))].join('・');
    $('pool-note').textContent = names;
  }
  function startGame() {
    state.questions = makeQuestions(payload.datasets, state.mode);
    state.results = []; state.index = 0;
    showScreen('game-screen'); renderRound();
  }
  function renderRound() {
    const q = state.questions[state.index];
    state.answered = false;
    state.value = q.data.region === 'world' ? q.center : q.axis === 'latitude' ? 35 : 138;
    $('round-number').textContent = String(state.index + 1).padStart(2, '0');
    $('running-score').textContent = state.results.reduce((sum, r) => sum + r.score, 0).toLocaleString('ja-JP');
    $('progress').replaceChildren(...Array.from({length: 5}, (_, i) => {
      const li = document.createElement('li'); li.className = i < state.index ? 'done' : i === state.index ? 'current' : '';
      li.setAttribute('aria-label', `第${i + 1}問${i < state.index ? ' 回答済み' : i === state.index ? ' 回答中' : ''}`); return li;
    }));
    $('question-kicker').textContent = `${regionNames[q.data.region]} / ${q.data.metadata.year}`;
    const subject = q.data.metric === 'rainfall' ? `${regionNames[q.data.region]}に降る水の年間総量` : `${regionNames[q.data.region]}の${q.data.metadata.name}`;
    $('question-title').textContent = subject;
    $('direction-text').textContent = q.axis === 'longitude' ? '左右が50:50になる位置に線を動かす' : '上下が50:50になる位置に線を動かす';
    $('map-region').textContent = q.data.region === 'world' ? `中心：${coordinate(q.center, 'longitude', 0)}` : '日本';
    $('map-year').textContent = `${q.data.metadata.year} · ${q.data.metadata.resolution}`;
    $('game-map').classList.toggle('world-map', q.data.region === 'world');
    state.view = buildMap($('game-map'), q.data.region, false, q.center);
    const bounds = state.view.bounds;
    $('answer-slider').min = bounds[q.axis === 'longitude' ? 0 : 1];
    $('answer-slider').max = bounds[q.axis === 'longitude' ? 2 : 3];
    $('answer-slider').disabled = false;
    $('coordinate-label').textContent = q.axis === 'longitude' ? '経度' : '緯度';
    $('answer-slider').setAttribute('aria-label', q.axis === 'longitude' ? '回答する経度' : '回答する緯度');
    $('minus-button').setAttribute('aria-label', q.axis === 'longitude' ? '線を左へ0.05度移動' : '線を下へ0.05度移動');
    $('plus-button').setAttribute('aria-label', q.axis === 'longitude' ? '線を右へ0.05度移動' : '線を上へ0.05度移動');
    $('answer-controls').hidden = false; $('round-result').hidden = true;
    $('round-result').classList.remove('perfect');
    $('map-instruction').textContent = '地図をクリック、またはドラッグして線を動かす';
    const caveat = q.data.metric.startsWith('rain') ? (q.data.region === 'world' ? '海洋・極域を含む。暫定値。' : '日本の陸域・有効セルのみ。') : q.data.metric === 'population' ? '推計人口。' : q.data.metric === 'building' ? '建物の地表被覆面積。2020年推計。' : q.data.metric === 'ocean' ? '原図の水域。湖なども含む。' : q.data.metric === 'land' ? '南極を含む。原図の海岸線・陸水表現に基づく。' : '日本境界内の有効セルのみ。';
    $('question-source').textContent = `${q.data.metadata.dataset} · ${q.data.metadata.year} · ${q.data.metadata.resolution}｜${caveat} 詳細はデータ`;
    updateLine();
  }
  function setLine(element, value, axis) {
    const view = state.view, lon = axis === 'longitude';
    const coords = lon ? {x1: view.x(value), x2: view.x(value), y1: 35, y2: view.height - 30} :
      {x1: 6, x2: view.width - 6, y1: view.y(value), y2: view.y(value)};
    for (const [key, val] of Object.entries(coords)) element.setAttribute(key, val);
  }
  function updateLine() {
    const q = state.questions[state.index];
    const view = state.view;
    setLine($('answer-line'), state.value, q.axis);
    $('answer-handle').setAttribute('cx', q.axis === 'longitude' ? view.x(state.value) : view.width / 2);
    $('answer-handle').setAttribute('cy', q.axis === 'latitude' ? view.y(state.value) : view.height / 2);
    $('coordinate-value').textContent = coordinate(state.value, q.axis);
    $('answer-slider').value = state.value;
    $('answer-slider').setAttribute('aria-valuetext', coordinate(state.value, q.axis));
  }
  function changeValue(value) {
    if (state.answered) return;
    state.value = clamp(Math.round(value * 100) / 100, +$('answer-slider').min, +$('answer-slider').max);
    updateLine();
  }
  function submitAnswer() {
    if (state.answered || state.screen !== 'game-screen') return;
    state.answered = true;
    const q = state.questions[state.index], result = evaluate(q.data[q.axis], state.value, q.left);
    const record = {...result, question: q, value: state.value};
    state.results.push(record);
    $('answer-controls').hidden = true; $('round-result').hidden = false;
    $('answer-slider').disabled = true;
    $('correct-line').setAttribute('visibility', 'visible');
    setLine($('correct-line'), q.answer, q.axis);
    $('result-label').textContent = '結果';
    $('result-ratio').innerHTML = `${(result.fraction * 100).toFixed(2)}<span>:</span>${(100 - result.fraction * 100).toFixed(2)}`;
    $('ratio-fill').style.width = `${result.fraction * 100}%`;
    $('first-side').textContent = q.axis === 'longitude' ? '左側' : '下側（南）';
    $('second-side').textContent = q.axis === 'longitude' ? '右側' : '上側（北）';
    $('result-error').textContent = result.error.toFixed(2);
    $('result-score').textContent = result.score.toLocaleString('ja-JP');
    $('result-stars').innerHTML = starsMarkup(result.stars);
    $('result-star-count').textContent = `${result.stars} / 10`;
    $('result-stars').setAttribute('aria-label', `10つ星中${result.stars}つ星`);
    $('round-result').classList.toggle('perfect', result.stars === 10);
    $('line-summary').innerHTML = `<span class="line-key"></span>回答：${coordinate(state.value, q.axis)}<span class="line-key correct"></span>正解：${coordinate(q.answer, q.axis)}`;
    $('map-instruction').textContent = '実線：あなたの回答　／　破線：50%地点';
    $('next-button').innerHTML = state.index === 4 ? '総合結果を見る <span>→</span>' : '次の問題へ <span>→</span>';
    $('running-score').textContent = state.results.reduce((sum, r) => sum + r.score, 0).toLocaleString('ja-JP');
    $('next-button').focus({preventScroll: true});
  }
  function showFinal() {
    const score = state.results.reduce((sum, r) => sum + r.score, 0);
    const avgError = state.results.reduce((sum, r) => sum + r.error, 0) / 5;
    const avgStars = state.results.reduce((sum, r) => sum + r.stars, 0) / 5;
    const finalRating = Math.round(avgStars);
    $('final-score').textContent = score.toLocaleString('ja-JP');
    window.dispatchEvent(new CustomEvent('game-finished', {detail: {mode: state.mode, score}}));
    $('final-stars').innerHTML = starsMarkup(finalRating);
    $('final-stars').setAttribute('aria-label', `最終評価10つ星中${finalRating}つ星`);
    $('average-error').textContent = `${avgError.toFixed(2)} pt`;
    $('average-stars').textContent = `${avgStars.toFixed(1)} / 10`;
    $('final-rating').textContent = `★ ${finalRating} / 10`;
    $('round-history').replaceChildren(...state.results.map((r, i) => {
      const row = document.createElement('div'), q = r.question;
      row.className = 'history-row';
      row.innerHTML = `<span class="number">0${i + 1}</span><div><h3>${regionNames[q.data.region]} / ${metricNames[q.data.metric]}${q.center === undefined ? '' : ` / 中心 ${coordinate(q.center, q.axis, 0)}`}</h3><p>誤差 ${r.error.toFixed(2)} pt · ★${r.stars} · 回答 ${coordinate(r.value, q.axis)} → 正解 ${coordinate(q.answer, q.axis)}</p></div><span class="stars" aria-label="${r.stars}つ星">${starsMarkup(r.stars)}</span><span class="points">${r.score.toLocaleString('ja-JP')} <small>pts</small></span>`;
      return row;
    }));
    showScreen('final-screen'); $('replay-button').focus({preventScroll: true});
  }
  function goHome() {
    if (state.screen === 'game-screen' && !window.confirm('プレイを終了して、エリア選択へ戻りますか？')) return;
    showScreen('home-screen');
  }
  function openInfo(kind) {
    const content = $('dialog-content'); content.replaceChildren();
    $('dialog-title').textContent = kind === 'data' ? '使用データ' : '遊び方';
    if (kind === 'how') {
      content.innerHTML = '<h2>遊び方</h2><ol><li>エリアを選びます。1ゲーム5問です。</li><li>経度問題は左右、緯度問題は上下の量が50:50になるように線を動かします。</li><li>「ここで分ける」で確定すると、実際の割合と正解が表示されます。</li></ol><p>世界地図の中心は毎問変わります。画面の左端から回答線までと、回答線から右端までの量で採点します。正解の経度も地図の中心に応じて変わります。日本地図は固定表示で、経度と緯度をランダムに出題します。</p><p>クリック・タップ・ドラッグ、スライダーで操作できます。±は0.05°、矢印キーは0.01°ずつ移動します。</p><h3>得点</h3><p>1問1,000点、合計5,000点。50%からの誤差が小さいほど高得点です。誤差0.5ポイント以下で★10、10ポイントで★5。最終評価は平均星数の四捨五入です。</p><h3>出題データ</h3><p>世界：人口・建物被覆・陸地・海洋・降水。降水は月別12・四半期別4・半期別2・年間1の19期間。日本：人口・樹木被覆・農地・市街地・草地・水面・低木地・湿地・裸地・岩場・降水。月別降水はすべて2025年の指定月の合計です。指標は繰り返すことがあります。世界の降水は海洋・極域を含み、日本の降水は陸域のみです。</p>';
    } else {
      const title = document.createElement('h2'); title.textContent = '使用データ'; content.append(title);
      const intro = document.createElement('p'); intro.textContent = '公開された実グリッドを集計しています。世界の陸地面積は実地図ポリゴンから計算しています。ゲーム独自の架空分布・首都への置き換え・欠損値の推測補完は使いません。細かな回答操作は元データの解像度を上げるものではありません。'; content.append(intro);
      for (const data of payload.datasets) {
        const section = document.createElement('section'); section.className = 'data-entry';
        const h3 = document.createElement('h3'); h3.textContent = `${regionNames[data.region]} / ${data.metadata.name}`; section.append(h3);
        const spec = document.createElement('p'); spec.className = 'data-spec'; spec.textContent = `${data.metadata.dataset} · ${data.metadata.year} · ${data.metadata.resolution}`; section.append(spec);
        for (const text of [data.metadata.provider + ' / ' + data.metadata.license, data.metadata.method, data.metadata.note]) {
          const p = document.createElement('p'); p.textContent = text; section.append(p);
        }
        const link = document.createElement('a'); link.href = data.metadata.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '提供元を見る ↗'; section.append(link);
        content.append(section);
      }
      const note = document.createElement('section'); note.className = 'data-entry';
      note.innerHTML = '<h3>地図と、今回収録していないデータ</h3><p>世界：Natural Earth 1:50m（Public domain）。日本：geoBoundaries gbOpen JPN ADM0、国土数値情報2022年由来（CC BY 4.0）。地図は実境界を表示向けに簡略化しています。統計集計では詳細な元境界を使います。</p><p>森林・農地の世界版は全球10mの全量集計を未実施。夜間光は未取得。化石CO₂はEDGAR/IEAの配布条件を確認し、今回の再配布対象から外しています。</p><p>元データの出典・SHA-256・総量・検証結果は、同梱のREADME、DATA_SOURCES.md、validation.jsonに記録しています。</p>';
      content.append(note);
    }
    $('info-dialog').showModal();
  }
  for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    for (const item of document.querySelectorAll('[data-mode]')) {
      const selected = item === button; item.classList.toggle('selected', selected); item.setAttribute('aria-pressed', selected);
    }
    updatePool();
  });
  $('start-button').addEventListener('click', startGame);
  $('replay-button').addEventListener('click', startGame);
  $('choose-button').addEventListener('click', goHome);
  $('home-button').addEventListener('click', goHome);
  $('submit-button').addEventListener('click', submitAnswer);
  $('next-button').addEventListener('click', () => {
    if (!state.answered) return;
    if (state.index === 4) showFinal(); else {state.index++; renderRound(); window.scrollTo({top: 0, behavior: 'instant'}); $('answer-slider').focus({preventScroll: true});}
  });
  $('answer-slider').addEventListener('input', event => changeValue(+event.target.value));
  $('minus-button').addEventListener('click', () => changeValue(state.value - .05));
  $('plus-button').addEventListener('click', () => changeValue(state.value + .05));
  $('answer-slider').addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); changeValue(state.value + (['ArrowUp', 'ArrowRight'].includes(event.key) ? .01 : -.01));
    }
  });
  let dragging = false;
  function movePointer(event) {
    if (!dragging || state.answered) return;
    const rect = $('game-map').getBoundingClientRect(), view = state.view, q = state.questions[state.index];
    const x = (event.clientX - rect.left) * view.width / rect.width;
    const y = (event.clientY - rect.top) * view.height / rect.height;
    changeValue(q.axis === 'longitude' ? view.lon(x) : view.lat(y));
  }
  $('game-map').addEventListener('pointerdown', event => {
    if (state.answered || (event.pointerType === 'mouse' && event.button !== 0)) return;
    dragging = true; $('game-map').setPointerCapture(event.pointerId); movePointer(event);
  });
  $('game-map').addEventListener('pointermove', movePointer);
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('game-map').addEventListener(event, () => {dragging = false;});
  $('how-button').addEventListener('click', () => openInfo('how'));
  $('data-button').addEventListener('click', () => openInfo('data'));
  $('close-dialog').addEventListener('click', () => $('info-dialog').close());
  $('info-dialog').addEventListener('click', event => {if (event.target === $('info-dialog')) {const r = $('info-dialog').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('info-dialog').close();}});
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.screen !== 'game-screen') return;
      const q = state.questions[state.index]; state.view = buildMap($('game-map'), q.data.region, false, q.center); updateLine();
      if (state.answered) {setLine($('correct-line'), q.answer, q.axis); $('correct-line').setAttribute('visibility', 'visible');}
    }, 120);
  });
  updatePool();
})(typeof window !== 'undefined' ? window : globalThis);






