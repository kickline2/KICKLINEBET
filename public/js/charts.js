// Small dependency-free SVG charts (the CSP allows only same-origin scripts).
// Text is always set via textContent; colours come from CSS custom properties.
import { h } from './core.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
  return el;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function ticks(min, max, count = 4) {
  const out = [];
  for (let i = 0; i <= count; i++) out.push(min + ((max - min) * i) / count);
  return out;
}
/** Round domain to a "nice" step so every tick lands on a round number (zero always included). */
function niceDomain(values, count = 4) {
  const lo = Math.min(0, ...values);
  const hi = Math.max(0, ...values);
  if (lo === hi) return { min: 0, max: 1, count };
  const step = niceMax((hi - lo) / count);
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  return { min, max, count: Math.round((max - min) / step) };
}
const shortDate = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });

function frame(container, height) {
  const width = Math.max(280, container.clientWidth || 600);
  const m = { t: 12, r: 12, b: 26, l: 64 };
  const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', class: 'chart-svg' });
  return { svg, width, height, m, iw: width - m.l - m.r, ih: height - m.t - m.b };
}

function axes(f, labels, min, max, fmt, xAt, count = 4) {
  const g = s('g', { class: 'axis' });
  for (const t of ticks(min, max, count)) {
    const y = f.m.t + f.ih - ((t - min) / (max - min)) * f.ih;
    g.appendChild(s('line', { x1: f.m.l, x2: f.m.l + f.iw, y1: y, y2: y, class: t === 0 ? 'grid zero' : 'grid' }));
    g.appendChild(s('text', { x: f.m.l - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, fmt(t)));
  }
  const step = Math.max(1, Math.ceil(labels.length / Math.floor(f.iw / 70)));
  labels.forEach((d, i) => {
    if (i % step && i !== labels.length - 1) return;
    const x = xAt(i);
    const anchor = x - f.m.l < 20 ? 'start' : f.m.l + f.iw - x < 20 ? 'end' : 'middle';
    g.appendChild(s('text', { x, y: f.height - 6, 'text-anchor': anchor, class: 'tick' }, shortDate(d)));
  });
  return g;
}

function legend(series) {
  if (series.length < 2) return null;
  return h('div', { class: 'chart-legend' }, series.map((se) =>
    h('span', { class: 'legend-item' }, h('span', { class: `swatch ${se.cls}` }), se.name)));
}

function tooltipLayer(wrap) {
  const tip = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  wrap.appendChild(tip);
  return {
    show(x, y, title, rows) {
      tip.replaceChildren(h('div', { class: 'tip-title' }, title), ...rows.map(([cls, name, val]) =>
        h('div', { class: 'tip-row' }, cls ? h('span', { class: `swatch ${cls}` }) : null, h('span', null, name), h('strong', null, val))));
      tip.hidden = false;
      const w = wrap.clientWidth;
      tip.style.left = `${Math.min(Math.max(x + 12, 0), w - 190)}px`;
      tip.style.top = `${Math.max(y - 10, 0)}px`;
    },
    hide() { tip.hidden = true; },
  };
}

/** Multi-series line chart with crosshair + tooltip. series: [{name, cls, values}] */
export function lineChart(container, { labels, series, fmt, axisFmt = fmt, height = 220 }) {
  const draw = () => {
    const f = frame(container, height);
    const { min, max, count } = niceDomain(series.flatMap((x) => x.values));
    const X = (i) => f.m.l + (labels.length === 1 ? f.iw / 2 : (i / (labels.length - 1)) * f.iw);
    const Y = (v) => f.m.t + f.ih - ((v - min) / (max - min)) * f.ih;
    f.svg.appendChild(axes(f, labels, min, max, axisFmt, X, count));
    for (const se of series) {
      const d = se.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('');
      f.svg.appendChild(s('path', { d, class: `line ${se.cls}` }));
    }
    const cross = s('line', { class: 'crosshair', y1: f.m.t, y2: f.m.t + f.ih, visibility: 'hidden' });
    const dots = series.map((se) => s('circle', { r: 4.5, class: `dot ${se.cls}`, visibility: 'hidden' }));
    f.svg.append(cross, ...dots);
    const hit = s('rect', { x: f.m.l, y: f.m.t, width: f.iw, height: f.ih, fill: 'transparent' });
    f.svg.appendChild(hit);
    const wrap = h('div', { class: 'chart-wrap' }, f.svg);
    const tip = tooltipLayer(wrap);
    const move = (clientX) => {
      const r = f.svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * f.width;
      const i = Math.max(0, Math.min(labels.length - 1, Math.round(((px - f.m.l) / f.iw) * (labels.length - 1))));
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('visibility', 'visible');
      series.forEach((se, k) => { dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(se.values[i])); dots[k].setAttribute('visibility', 'visible'); });
      tip.show((X(i) / f.width) * r.width, (Math.min(...series.map((se) => Y(se.values[i]))) / f.height) * r.height, shortDate(labels[i]), series.map((se) => [se.cls, se.name, fmt(se.values[i])]));
    };
    const leave = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach((d) => d.setAttribute('visibility', 'hidden')); tip.hide(); };
    hit.addEventListener('pointermove', (e) => move(e.clientX));
    hit.addEventListener('pointerleave', leave);
    container.replaceChildren(legend(series) || '', wrap);
  };
  draw();
  return draw;
}

/** Bar chart for one or two series per day. Negative values drop below the zero line. */
export function barChart(container, { labels, series, fmt, axisFmt = fmt, height = 200, negCls }) {
  const draw = () => {
    const f = frame(container, height);
    const { min, max, count } = niceDomain(series.flatMap((x) => x.values));
    const Y = (v) => f.m.t + f.ih - ((v - min) / (max - min)) * f.ih;
    const slot = f.iw / labels.length;
    f.svg.appendChild(axes(f, labels, min, max, axisFmt, (i) => f.m.l + (i + 0.5) * slot, count));
    const gap = 2;
    const bw = Math.max(2, Math.min(28, (slot - 4) / series.length - gap));
    const wrap = h('div', { class: 'chart-wrap' }, f.svg);
    const tip = tooltipLayer(wrap);
    labels.forEach((d, i) => {
      const x0 = f.m.l + i * slot + (slot - (bw + gap) * series.length + gap) / 2;
      series.forEach((se, k) => {
        const v = se.values[i];
        if (!v) return;
        const y = Math.min(Y(v), Y(0));
        const hgt = Math.max(1, Math.abs(Y(v) - Y(0)));
        f.svg.appendChild(s('rect', { x: x0 + k * (bw + gap), y, width: bw, height: hgt, rx: Math.min(4, bw / 2), class: `bar ${v < 0 && negCls ? negCls : se.cls}` }));
      });
      const hit = s('rect', { x: f.m.l + i * slot, y: f.m.t, width: slot, height: f.ih, fill: 'transparent' });
      hit.addEventListener('pointerenter', () => {
        const r = f.svg.getBoundingClientRect();
        tip.show(((f.m.l + (i + 0.5) * slot) / f.width) * r.width, 10, shortDate(d), series.map((se) => [se.values[i] < 0 && negCls ? negCls : se.cls, se.name, fmt(se.values[i])]));
      });
      hit.addEventListener('pointerleave', () => tip.hide());
      f.svg.appendChild(hit);
    });
    container.replaceChildren(legend(series) || '', wrap);
  };
  draw();
  return draw;
}

/** Horizontal ranked bars in HTML (labels stay crisp and wrap on phones). */
export function rankBars(container, rows, { label, value, fmt, sub }) {
  const max = Math.max(1, ...rows.map(value));
  container.replaceChildren(...rows.map((r) => h('div', { class: 'rank-row', title: `${label(r)}: ${fmt(value(r))}` },
    h('div', { class: 'rank-label' }, h('span', null, label(r)), sub ? h('small', { class: 'muted' }, sub(r)) : null),
    h('div', { class: 'rank-track' }, (() => {
      const fill = h('div', { class: 'rank-fill' });
      fill.style.width = `${Math.max(2, (value(r) / max) * 100).toFixed(1)}%`; // CSSOM, allowed by the strict CSP
      return fill;
    })()),
    h('div', { class: 'rank-val' }, fmt(value(r))))));
}
