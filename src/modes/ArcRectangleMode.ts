import { TerraDrawExtend } from 'terra-draw';
import type {
  TerraDrawMouseEvent,
  TerraDrawKeyboardEvent,
  TerraDrawAdapterStyling,
  GeoJSONStoreFeatures,
} from 'terra-draw';

type HexColor = `#${string}`;
type HexColorStyling = HexColor | ((f: GeoJSONStoreFeatures) => HexColor | undefined);
type NumericStyling = number | ((f: GeoJSONStoreFeatures) => number | undefined);

type ArcRectangleStyling = {
  fillColor: HexColorStyling;
  fillOpacity: NumericStyling;
  outlineColor: HexColorStyling;
  outlineWidth: NumericStyling;
  outlineOpacity: NumericStyling;
};

type Pixel = { x: number; y: number };
type Geo = [number, number]; // [lng, lat]

const ARC_SEGMENTS = 24;
const SIDE_HIT_PX = 14;
const MAX_ARC_FRACTION = 0.5;

// ---- ユーティリティ ----

function distToSegment(P: Pixel, A: Pixel, B: Pixel): number {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 0.001) return Math.hypot(P.x - A.x, P.y - A.y);
  const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2));
  return Math.hypot(P.x - A.x - t * dx, P.y - A.y - t * dy);
}

function outwardNormal(A: Pixel, B: Pixel, center: Pixel): Pixel {
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const L = Math.hypot(dx, dy);
  const n = { x: -dy / L, y: dx / L };
  const Mx = (A.x + B.x) / 2;
  const My = (A.y + B.y) / 2;
  if (n.x * (center.x - Mx) + n.y * (center.y - My) > 0) {
    return { x: -n.x, y: -n.y };
  }
  return n;
}

function pointInConvexQuad(P: Pixel, quad: [Pixel, Pixel, Pixel, Pixel]): boolean {
  let sign: number | undefined;
  for (let i = 0; i < 4; i++) {
    const A = quad[i];
    const B = quad[(i + 1) % 4];
    const cross = (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === undefined) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== undefined;
}

function computeArcPoints(A: Pixel, B: Pixel, s: number, n: Pixel, segments: number): Pixel[] {
  const L = Math.hypot(B.x - A.x, B.y - A.y);
  if (L < 0.1) return [A];
  const absS = Math.abs(s);
  const R = (4 * s * s + L * L) / (8 * absS);
  const Mx = (A.x + B.x) / 2;
  const My = (A.y + B.y) / 2;
  const sign = s > 0 ? 1 : -1;
  const Cx = Mx - sign * n.x * (R - absS);
  const Cy = My - sign * n.y * (R - absS);
  const θA = Math.atan2(A.y - Cy, A.x - Cx);
  const θB = Math.atan2(B.y - Cy, B.x - Cx);
  const bulgeX = Mx + sign * n.x * absS;
  const bulgeY = My + sign * n.y * absS;
  const θP = Math.atan2(bulgeY - Cy, bulgeX - Cx);
  let dθCCW = θB - θA;
  while (dθCCW <= 0) dθCCW += 2 * Math.PI;
  let θP_fromA = θP - θA;
  while (θP_fromA < 0) θP_fromA += 2 * Math.PI;
  const useCCW = θP_fromA < dθCCW;
  const dθ = useCCW ? dθCCW : -(2 * Math.PI - dθCCW);
  const pts: Pixel[] = [];
  for (let i = 0; i < segments; i++) {
    const angle = θA + (i / segments) * dθ;
    pts.push({ x: Cx + R * Math.cos(angle), y: Cy + R * Math.sin(angle) });
  }
  return pts;
}

// ---- モード本体 ----

/**
 * 円弧矩形描画モード。
 *
 * 【描画フェーズ】
 *   クリック or ドラッグで2点を指定して矩形を確定
 *
 * 【編集フェーズ】
 *   辺をクリック → その辺を選択（中点マーカー表示）
 *     別の辺をクリック → 選択切り替え
 *     辺以外をクリック → 選択解除
 *   選択中にドラッグ → 円弧の深さをリアルタイム調整
 *     外側へ引く = 外向き膨らみ / 内側へ引く = 内向き凹み
 *   Enter → 確定  /  Escape → キャンセル
 */
export class ArcRectangleMode extends TerraDrawExtend.TerraDrawBaseDrawMode<ArcRectangleStyling> {
  override mode = 'arc-rectangle';

  private _phase: 'idle' | 'drawing' | 'editing' = 'idle';
  private _startPixel: Pixel | undefined;
  private _currentId: string | number | undefined;
  private _corners: [Geo, Geo, Geo, Geo] | undefined; // [TL, TR, BR, BL]
  private _arcFractions: [number, number, number, number] = [0, 0, 0, 0];

  // 辺の選択状態
  private _selectedSide: number | undefined;
  private _markerFeatureId: string | number | undefined;

  // ドラッグ状態
  private _isDragging = false;
  private _dragStartPixel: Pixel | undefined;
  private _dragStartFraction = 0;
  private _dragStartCorners: [Geo, Geo, Geo, Geo] | undefined; // 移動ドラッグ用

  constructor(options?: TerraDrawExtend.BaseModeOptions<ArcRectangleStyling>) {
    super(options);
  }

  // ---- 内部ヘルパー ----

  private getCornerPixels(): [Pixel, Pixel, Pixel, Pixel] {
    const [[lng0, lat0], [lng1, lat1], [lng2, lat2], [lng3, lat3]] = this._corners!;
    return [
      this.project(lng0, lat0),
      this.project(lng1, lat1),
      this.project(lng2, lat2),
      this.project(lng3, lat3),
    ];
  }

  private getSides(
    px: [Pixel, Pixel, Pixel, Pixel],
  ): [[Pixel, Pixel], [Pixel, Pixel], [Pixel, Pixel], [Pixel, Pixel]] {
    return [[px[0], px[1]], [px[1], px[2]], [px[2], px[3]], [px[3], px[0]]];
  }

  private centerOf(px: [Pixel, Pixel, Pixel, Pixel]): Pixel {
    return {
      x: (px[0].x + px[1].x + px[2].x + px[3].x) / 4,
      y: (px[0].y + px[1].y + px[2].y + px[3].y) / 4,
    };
  }

  private rectCoordsFromPixels(sp: Pixel, ep: Pixel): [number, number][][] {
    const minX = Math.min(sp.x, ep.x);
    const maxX = Math.max(sp.x, ep.x);
    const minY = Math.min(sp.y, ep.y);
    const maxY = Math.max(sp.y, ep.y);
    const tl = this.unproject(minX, minY);
    const tr = this.unproject(maxX, minY);
    const br = this.unproject(maxX, maxY);
    const bl = this.unproject(minX, maxY);
    return [[[tl.lng, tl.lat], [tr.lng, tr.lat], [br.lng, br.lat], [bl.lng, bl.lat], [tl.lng, tl.lat]]];
  }

  private setCorners(sp: Pixel, ep: Pixel): void {
    const minX = Math.min(sp.x, ep.x);
    const maxX = Math.max(sp.x, ep.x);
    const minY = Math.min(sp.y, ep.y);
    const maxY = Math.max(sp.y, ep.y);
    const tl = this.unproject(minX, minY);
    const tr = this.unproject(maxX, minY);
    const br = this.unproject(maxX, maxY);
    const bl = this.unproject(minX, maxY);
    this._corners = [[tl.lng, tl.lat], [tr.lng, tr.lat], [br.lng, br.lat], [bl.lng, bl.lat]];
    this._arcFractions = [0, 0, 0, 0];
  }

  private computeArcPolygon(): [number, number][][] {
    const cornerPx = this.getCornerPixels();
    const center = this.centerOf(cornerPx);
    const sides = this.getSides(cornerPx);
    const ring: [number, number][] = [];
    for (let i = 0; i < 4; i++) {
      const [A, B] = sides[i];
      const fraction = this._arcFractions[i];
      if (Math.abs(fraction) < 0.005) {
        const g = this.unproject(A.x, A.y);
        ring.push([g.lng, g.lat]);
      } else {
        const sideLen = Math.hypot(B.x - A.x, B.y - A.y);
        const s = fraction * sideLen;
        const n = outwardNormal(A, B, center);
        for (const p of computeArcPoints(A, B, s, n, ARC_SEGMENTS)) {
          const g = this.unproject(p.x, p.y);
          ring.push([g.lng, g.lat]);
        }
      }
    }
    if (ring.length > 0) ring.push(ring[0]);
    return [ring];
  }

  private nearestSide(mouseX: number, mouseY: number): number | undefined {
    if (!this._corners) return undefined;
    const sides = this.getSides(this.getCornerPixels());
    const P = { x: mouseX, y: mouseY };
    let minDist = Infinity;
    let closest = -1;
    for (let i = 0; i < 4; i++) {
      const d = distToSegment(P, sides[i][0], sides[i][1]);
      if (d < minDist) { minDist = d; closest = i; }
    }
    return minDist <= SIDE_HIT_PX ? closest : undefined;
  }

  private updateGeometry(coords: [number, number][][]): void {
    if (this._currentId === undefined) return;
    this.store.updateGeometry([{
      id: this._currentId,
      geometry: { type: 'Polygon', coordinates: coords },
    }]);
  }

  /** 選択中の辺の円弧頂点（弧の最大変位点）の地理座標を返す */
  private markerGeo(): { lng: number; lat: number } {
    const cornerPx = this.getCornerPixels();
    const center = this.centerOf(cornerPx);
    const [A, B] = this.getSides(cornerPx)[this._selectedSide!];
    const fraction = this._arcFractions[this._selectedSide!];
    let mx = (A.x + B.x) / 2;
    let my = (A.y + B.y) / 2;
    if (Math.abs(fraction) >= 0.005) {
      const sideLen = Math.hypot(B.x - A.x, B.y - A.y);
      const n = outwardNormal(A, B, center);
      mx += fraction * sideLen * n.x;
      my += fraction * sideLen * n.y;
    }
    return this.unproject(mx, my);
  }

  /** 選択中の辺の円弧頂点にマーカーポイントを配置する（選択変更時） */
  private syncMarker(): void {
    if (this._markerFeatureId !== undefined) {
      this.store.delete([this._markerFeatureId]);
      this._markerFeatureId = undefined;
    }
    if (this._selectedSide === undefined || !this._corners) return;

    const geo = this.markerGeo();
    const [id] = this.store.create([{
      geometry: { type: 'Point', coordinates: [geo.lng, geo.lat] },
      properties: { mode: this.mode, isMarker: true },
    }]);
    this._markerFeatureId = id;
  }

  /** ドラッグ中にマーカーの位置だけを更新する（削除・再作成しない） */
  private moveMarker(): void {
    if (this._markerFeatureId === undefined || this._selectedSide === undefined || !this._corners) return;
    const geo = this.markerGeo();
    this.store.updateGeometry([{
      id: this._markerFeatureId,
      geometry: { type: 'Point', coordinates: [geo.lng, geo.lat] },
    }]);
  }

  /** 辺を選択する（undefined で選択解除） */
  private selectSide(side: number | undefined): void {
    this._selectedSide = side;
    this.syncMarker();
  }

  /** ポリゴンのリングとarcFractionsからコーナー座標を再構築する（回転・移動後も正確） */
  private cornersFromRing(
    ring: [number, number][],
    arcFractions: [number, number, number, number],
  ): [Geo, Geo, Geo, Geo] | undefined {
    let idx = 0;
    const corners: Geo[] = [];
    for (let i = 0; i < 4; i++) {
      if (idx >= ring.length) return undefined;
      corners.push(ring[idx] as Geo);
      idx += Math.abs(arcFractions[i]) < 0.005 ? 1 : ARC_SEGMENTS;
    }
    return corners.length === 4 ? (corners as [Geo, Geo, Geo, Geo]) : undefined;
  }

  /** クリック位置付近の確定済みフィーチャーを探す */
  private findExistingNearClick(mouseX: number, mouseY: number): {
    id: string | number;
    arcFractions: [number, number, number, number];
    corners: [Geo, Geo, Geo, Geo];
    sideIdx: number | undefined;
  } | undefined {
    const P: Pixel = { x: mouseX, y: mouseY };
    for (const feature of this.store.copyAll()) {
      if (
        feature.properties['isMarker'] ||
        feature.properties['mode'] !== this.mode ||
        feature.properties['currentlyDrawing'] ||
        feature.geometry.type !== 'Polygon'
      ) continue;
      const raw = feature.properties['arcFractions'];
      if (!Array.isArray(raw) || raw.length !== 4) continue;
      const arcFractions = raw as [number, number, number, number];
      const corners = this.cornersFromRing(
        feature.geometry.coordinates[0] as [number, number][],
        arcFractions,
      );
      if (!corners) continue;
      const cornerPx = corners.map(([lng, lat]) => this.project(lng, lat)) as [Pixel, Pixel, Pixel, Pixel];
      const sides = this.getSides(cornerPx);
      let sideIdx: number | undefined;
      let minDist = Infinity;
      for (let i = 0; i < 4; i++) {
        const d = distToSegment(P, sides[i][0], sides[i][1]);
        if (d < minDist) { minDist = d; sideIdx = i; }
      }
      if (minDist > SIDE_HIT_PX) sideIdx = undefined;
      if (sideIdx !== undefined || pointInConvexQuad(P, cornerPx)) {
        return { id: feature.id as string | number, arcFractions, corners, sideIdx };
      }
    }
    return undefined;
  }

  /** 既存フィーチャーの再編集を開始する */
  private resumeEditing(
    existing: { id: string | number; arcFractions: [number, number, number, number]; corners: [Geo, Geo, Geo, Geo] },
  ): void {
    this._currentId = existing.id;
    this._corners = existing.corners;
    this._arcFractions = [...existing.arcFractions] as [number, number, number, number];
    this._phase = 'editing';
    this.store.updateProperty([{ id: existing.id, property: 'currentlyDrawing', value: true }]);
  }

  private enterEditing(sp: Pixel, ep: Pixel): void {
    this.setCorners(sp, ep);
    this._phase = 'editing';
    this.updateGeometry(this.computeArcPolygon());
    // 矩形確定後は「描画中」ではないことを terra-draw に伝える（モード切替ボタンを有効化）
    this.setStarted();
    this.setCursor('crosshair');
  }

  private finishEditing(): void {
    if (!this._currentId || !this._corners) return;
    this.updateGeometry(this.computeArcPolygon());
    this.store.updateProperty([
      { id: this._currentId, property: 'currentlyDrawing', value: null },
      { id: this._currentId, property: 'arcFractions', value: [...this._arcFractions] },
    ]);
    const id = this._currentId;
    this._currentId = undefined;
    this._phase = 'idle';
    this._startPixel = undefined;
    this._corners = undefined;
    this._arcFractions = [0, 0, 0, 0];
    this.setStarted();
    this.onFinish(id, { mode: this.mode, action: 'draw' });
  }

  // ---- TerraDrawBaseDrawMode 実装 ----

  override start(): void {
    this.setStarted();
    this.setCursor('crosshair');
  }

  override stop(): void {
    if (this._phase === 'editing' && this._currentId !== undefined) {
      // 円弧編集中にモード切替 → 自動確定して図形を保持
      if (this._markerFeatureId !== undefined) {
        this.store.delete([this._markerFeatureId]);
        this._markerFeatureId = undefined;
      }
      this._selectedSide = undefined;
      this.finishEditing();
      // finishEditing() が setStarted() を呼ぶので state = 'started' になる
    } else {
      const wasDrawing = this._phase === 'drawing';
      this.cleanUp();
      if (wasDrawing) {
        // 初期矩形描画中の切替: 'drawing' state を 'started' に戻してから停止
        this.setStarted();
      }
    }
    this.setStopped();
    this.setCursor('unset');
  }

  override cleanUp(): void {
    if (this._markerFeatureId !== undefined) {
      this.store.delete([this._markerFeatureId]);
      this._markerFeatureId = undefined;
    }
    if (this._currentId !== undefined) {
      this.store.delete([this._currentId]);
      this._currentId = undefined;
    }
    this._phase = 'idle';
    this._startPixel = undefined;
    this._corners = undefined;
    this._arcFractions = [0, 0, 0, 0];
    this._selectedSide = undefined;
    this._isDragging = false;
    this._dragStartPixel = undefined;
    this._dragStartCorners = undefined;
  }

  override onClick(event: TerraDrawMouseEvent): void {
    if (this._phase === 'idle') {
      // 既存フィーチャーをクリック → 再編集モードへ
      const existing = this.findExistingNearClick(event.containerX, event.containerY);
      if (existing) {
        this.resumeEditing(existing);
        if (existing.sideIdx !== undefined) {
          this.selectSide(existing.sideIdx);
          this.setCursor('move');
        } else {
          this.setCursor('crosshair');
        }
        return;
      }
      // 新規描画開始
      this._startPixel = { x: event.containerX, y: event.containerY };
      const g = this.unproject(event.containerX, event.containerY);
      const pt: [number, number] = [g.lng, g.lat];
      const [id] = this.store.create([{
        geometry: { type: 'Polygon', coordinates: [[[...pt], [...pt], [...pt], [...pt], [...pt]]] },
        properties: { mode: this.mode, currentlyDrawing: true },
      }]);
      this._currentId = id;
      this._phase = 'drawing';
      this.setDrawing();

    } else if (this._phase === 'drawing') {
      this.enterEditing(this._startPixel!, { x: event.containerX, y: event.containerY });

    } else if (this._phase === 'editing') {
      const side = this.nearestSide(event.containerX, event.containerY);
      if (side !== undefined) {
        // 同じ辺をクリック → 選択解除、別の辺 → 選択切り替え
        this.selectSide(side === this._selectedSide ? undefined : side);
      } else {
        // 辺以外をクリック → 選択解除
        this.selectSide(undefined);
      }
      this.setCursor(this._selectedSide !== undefined ? 'move' : 'crosshair');
    }
  }

  override onMouseMove(event: TerraDrawMouseEvent): void {
    if (this._phase === 'drawing' && this._startPixel && this._currentId !== undefined) {
      this.updateGeometry(
        this.rectCoordsFromPixels(this._startPixel, { x: event.containerX, y: event.containerY }),
      );
    } else if (this._phase === 'editing' && !this._isDragging) {
      const side = this.nearestSide(event.containerX, event.containerY);
      if (this._selectedSide !== undefined) {
        this.setCursor('move'); // 選択済み → ドラッグ可能を示す
      } else {
        this.setCursor(side !== undefined ? 'pointer' : 'crosshair');
      }
    }
  }

  override onDragStart(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (this._phase === 'idle') {
      // 既存フィーチャーのドラッグ → 再編集してから円弧調整 or 移動
      const existing = this.findExistingNearClick(event.containerX, event.containerY);
      if (existing) {
        this.resumeEditing(existing);
        const side = existing.sideIdx ?? this.nearestSide(event.containerX, event.containerY);
        this._isDragging = true;
        this._dragStartPixel = { x: event.containerX, y: event.containerY };
        if (side !== undefined) {
          this.selectSide(side);
          this._dragStartFraction = this._arcFractions[side];
        } else {
          // 辺の外（中央など）→ 形状全体を移動
          this._dragStartCorners = [...this._corners!] as [Geo, Geo, Geo, Geo];
        }
        setMapDraggability(false);
        this.setCursor('move');
        return;
      }
      // ドラッグで矩形描画開始
      this._startPixel = { x: event.containerX, y: event.containerY };
      const g = this.unproject(event.containerX, event.containerY);
      const pt: [number, number] = [g.lng, g.lat];
      const [id] = this.store.create([{
        geometry: { type: 'Polygon', coordinates: [[[...pt], [...pt], [...pt], [...pt], [...pt]]] },
        properties: { mode: this.mode, currentlyDrawing: true },
      }]);
      this._currentId = id;
      this._phase = 'drawing';
      this.setDrawing();
      setMapDraggability(false);

    } else if (this._phase === 'editing') {
      let side = this._selectedSide;
      if (side === undefined) {
        side = this.nearestSide(event.containerX, event.containerY);
        if (side !== undefined) this.selectSide(side);
      }
      this._isDragging = true;
      this._dragStartPixel = { x: event.containerX, y: event.containerY };
      if (side !== undefined) {
        // 辺の近くでドラッグ → 円弧調整
        this._dragStartFraction = this._arcFractions[side];
      } else {
        // 辺の外でドラッグ → 形状全体を移動
        this._dragStartCorners = [...this._corners!] as [Geo, Geo, Geo, Geo];
      }
      setMapDraggability(false);
      this.setCursor('move');
    }
  }

  override onDrag(
    event: TerraDrawMouseEvent,
    _setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (this._phase === 'drawing' && this._startPixel && this._currentId !== undefined) {
      this.updateGeometry(
        this.rectCoordsFromPixels(this._startPixel, { x: event.containerX, y: event.containerY }),
      );

    } else if (this._phase === 'editing' && this._isDragging) {
      if (this._selectedSide !== undefined && this._corners) {
        // 円弧深さ調整
        const cornerPx = this.getCornerPixels();
        const center = this.centerOf(cornerPx);
        const [A, B] = this.getSides(cornerPx)[this._selectedSide];
        const sideLen = Math.hypot(B.x - A.x, B.y - A.y);
        if (sideLen < 1) return;
        const n = outwardNormal(A, B, center);
        const dx = event.containerX - this._dragStartPixel!.x;
        const dy = event.containerY - this._dragStartPixel!.y;
        const outward = dx * n.x + dy * n.y;
        const newFraction = this._dragStartFraction + outward / sideLen;
        this._arcFractions[this._selectedSide] = Math.max(
          -MAX_ARC_FRACTION,
          Math.min(MAX_ARC_FRACTION, newFraction),
        );
        this.updateGeometry(this.computeArcPolygon());
        this.moveMarker();

      } else if (this._dragStartCorners) {
        // 形状全体を移動
        const dx = event.containerX - this._dragStartPixel!.x;
        const dy = event.containerY - this._dragStartPixel!.y;
        this._corners = this._dragStartCorners.map(([lng, lat]) => {
          const px = this.project(lng, lat);
          const { lng: newLng, lat: newLat } = this.unproject(px.x + dx, px.y + dy);
          return [newLng, newLat] as Geo;
        }) as [Geo, Geo, Geo, Geo];
        this.updateGeometry(this.computeArcPolygon());
        if (this._selectedSide !== undefined) this.moveMarker();
      }
    }
  }

  override onDragEnd(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (this._phase === 'drawing' && this._startPixel) {
      this.enterEditing(this._startPixel, { x: event.containerX, y: event.containerY });
      setMapDraggability(true);

    } else if (this._phase === 'editing' && this._isDragging) {
      this._isDragging = false;
      this._dragStartPixel = undefined;
      this._dragStartCorners = undefined;
      setMapDraggability(true);
      this.setCursor(this._selectedSide !== undefined ? 'move' : 'crosshair');
    }
  }

  override onKeyUp(event: TerraDrawKeyboardEvent): void {
    if (event.key === 'Escape') {
      this.cleanUp();
      this.setStarted();
    } else if (event.key === 'Enter' && this._phase === 'editing') {
      // マーカーを削除してから確定
      if (this._markerFeatureId !== undefined) {
        this.store.delete([this._markerFeatureId]);
        this._markerFeatureId = undefined;
      }
      this._selectedSide = undefined;
      this.finishEditing();
    }
  }

  override styleFeature(feature: GeoJSONStoreFeatures): TerraDrawAdapterStyling {
    // 選択辺の中点マーカー
    if (feature.properties.isMarker === true) {
      return {
        pointColor: '#ff6600',
        pointWidth: 10,
        pointOutlineColor: '#ffffff',
        pointOutlineWidth: 2,
        pointOpacity: 1,
        pointOutlineOpacity: 1,
        polygonFillColor: '#ff6600',
        polygonFillOpacity: 0,
        polygonOutlineColor: '#ff6600',
        polygonOutlineWidth: 0,
        polygonOutlineOpacity: 0,
        lineStringColor: '#ff6600',
        lineStringWidth: 0,
        zIndex: 10,
      };
    }

    const isEditing =
      this._phase === 'editing' && feature.id === this._currentId;
    return {
      pointColor: '#e0600a',
      pointWidth: 5,
      pointOutlineColor: '#ffffff',
      pointOutlineWidth: 1,
      polygonFillColor: this.getHexColorStylingValue(this._styles.fillColor, '#e0600a', feature),
      polygonFillOpacity: this.getNumericStylingValue(
        this._styles.fillOpacity,
        isEditing ? 0.1 : 0.2,
        feature,
      ),
      polygonOutlineColor: this.getHexColorStylingValue(
        this._styles.outlineColor,
        isEditing ? '#ff6600' : '#e0600a',
        feature,
      ),
      polygonOutlineWidth: this.getNumericStylingValue(
        this._styles.outlineWidth,
        isEditing ? 3 : 2,
        feature,
      ),
      polygonOutlineOpacity: this.getNumericStylingValue(this._styles.outlineOpacity, 1, feature),
      lineStringColor: '#e0600a',
      lineStringWidth: 2,
      zIndex: 0,
    };
  }
}
