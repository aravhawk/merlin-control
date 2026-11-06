/**
 * On-demand part annotations. Anchors are projected from 3-D every frame; text is
 * pushed apart vertically (per side) so callouts never overlap, and an SVG leader
 * connects each text back to its anchor dot.
 */
import * as THREE from 'three';

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const NS = 'http://www.w3.org/2000/svg';
const GAP = 19; // minimum vertical spacing between callouts (px)
const SIDES = [-1, 1];
const byTy = (a, b) => a.ty - b.ty;

export class Labels {
  constructor(container, view) {
    this.el = container;
    this.view = view;
    this.visible = false;
    this.cols = { [-1]: [], 1: [] }; // reused per frame
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('class', 'label-lines');
    container.appendChild(this.svg);

    this.items = view.parts.map((p) => {
      const text = document.createElement('div');
      text.className = 'label';
      text.textContent = p.def.name;
      container.appendChild(text);
      const line = document.createElementNS(NS, 'polyline');
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('r', '2.6');
      this.svg.append(line, dot);
      return { id: p.def.id, text, line, dot, side: p.def.anchor[0] >= 0.1 ? 1 : -1, x: 0, y: 0, ty: 0, show: false, alpha: -1, pts: '' };
    });
    this.setVisible(false);
  }

  setVisible(v) {
    this.visible = v;
    this.el.style.display = v ? 'block' : 'none';
  }

  update(camera, width, height) {
    if (!this.visible) return;
    const iso = this.view.isolated;

    for (const it of this.items) {
      this.view.anchorWorld(it.id, _v);
      _p.copy(_v).project(camera);
      it.x = (_p.x * 0.5 + 0.5) * width;
      it.y = (-_p.y * 0.5 + 0.5) * height;
      it.show = _p.z < 1 && (!iso || iso === it.id);
      // side follows the screen half the anchor is in, with hysteresis so callouts don't flip-flop while rotating
      const c = width / 2;
      if (it.side > 0 && it.x < c - 40) it.side = -1;
      else if (it.side < 0 && it.x > c + 40) it.side = 1;
      it.ty = it.y;
    }

    // de-collide per side
    for (const side of SIDES) {
      const col = this.cols[side];
      col.length = 0;
      for (const i of this.items) if (i.show && i.side === side) col.push(i);
      col.sort(byTy);
      for (let i = 1; i < col.length; i++) col[i].ty = Math.max(col[i].ty, col[i - 1].ty + GAP);
      // pull the stack back up if it was pushed past the bottom
      const over = col.length ? col[col.length - 1].ty - (height - 24) : 0;
      if (over > 0) col.forEach((c) => (c.ty -= over));
    }

    // write to the DOM only when something actually changed (a still engine costs nothing)
    for (const it of this.items) {
      const p = this.view.byId.get(it.id);
      const alpha = it.show ? Math.round(Math.max(0.2, p.vis) * 100) / 100 : 0;
      if (alpha !== it.alpha) {
        it.alpha = alpha;
        it.text.style.opacity = alpha;
        it.line.style.opacity = alpha;
        it.dot.style.opacity = alpha;
      }
      if (!it.show) continue;
      const elbow = it.x + it.side * 26;
      const tx = elbow + it.side * 18;
      const pts = `${it.x.toFixed(1)},${it.y.toFixed(1)} ${elbow.toFixed(1)},${it.ty.toFixed(1)} ${tx.toFixed(1)},${it.ty.toFixed(1)}`;
      if (pts !== it.pts) {
        it.pts = pts;
        it.line.setAttribute('points', pts);
        it.dot.setAttribute('cx', it.x.toFixed(1));
        it.dot.setAttribute('cy', it.y.toFixed(1));
        it.text.style.transform = `translate(${(tx + it.side * 6).toFixed(1)}px, ${(it.ty - 8).toFixed(1)}px)${it.side < 0 ? ' translateX(-100%)' : ''}`;
      }
    }
  }
}
