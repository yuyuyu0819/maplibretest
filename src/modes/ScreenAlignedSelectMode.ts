import { TerraDrawSelectMode } from 'terra-draw';
import type { TerraDrawMouseEvent } from 'terra-draw';

type SelectOptions = ConstructorParameters<typeof TerraDrawSelectMode>[0];
type Pixel = { x: number; y: number };

function normalize(p: Pixel): Pixel {
  const len = Math.hypot(p.x, p.y);
  return len > 0 ? { x: p.x / len, y: p.y / len } : { x: 1, y: 0 };
}

function dot(a: Pixel, b: Pixel): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * TerraDrawSelectMode を拡張し、以下の操作を追加する。
 *
 * 【rectangle コーナードラッグ】
 *   頂点ドラッグ時に回転状態を維持したままリサイズする。
 *   ドラッグ開始時に矩形の2辺方向（u, v 単位ベクトル）を保存し、
 *   マウス位置→対角コーナー間のベクトルを u/v に射影して再計算。
 *
 * 【Ctrl+S スケーリング】
 *   Ctrl+S を押しながらドラッグすると、形状を維持したまま拡縮する。
 *   polygon / rectangle / circle のいずれにも対応。
 *   ドラッグ開始時にピクセル空間の重心と初期座標を記録し、
 *   重心からのカーソル距離比でスケールを算出。
 */
export class ScreenAlignedSelectMode extends TerraDrawSelectMode {
  // ---- rectangle コーナードラッグ用 ----
  private _rectDragOppGeo: [number, number] | undefined;
  private _rectDragU: Pixel | undefined;
  private _rectDragV: Pixel | undefined;
  private _rectDragIdx: number | undefined;

  // ---- Ctrl+S スケーリング用 ----
  private _scaleCenter: Pixel | undefined;
  private _scaleInitialDist: number | undefined;
  private _scaleId: string | number | undefined;
  private _scaleInitialGeo: [number, number][] | undefined;

  constructor(options: SelectOptions = {}) {
    super(options);
  }

  // ---- ヘルパー ----

  private _isScaleKey(event: TerraDrawMouseEvent): boolean {
    return event.heldKeys.includes('Control') && event.heldKeys.includes('s');
  }

  private _resetRectDrag(): void {
    this._rectDragOppGeo = undefined;
    this._rectDragU = undefined;
    this._rectDragV = undefined;
    this._rectDragIdx = undefined;
  }

  private _resetScale(): void {
    this._scaleCenter = undefined;
    this._scaleInitialDist = undefined;
    this._scaleId = undefined;
    this._scaleInitialGeo = undefined;
  }

  // ---- TerraDrawSelectMode オーバーライド ----

  override onDragStart(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (this._isScaleKey(event)) {
      // terra-draw の通常ドラッグをバイパスし、スケーリング状態を設定する
      const s = this as unknown as Record<string, any>;
      const selected = s['selected'] as (string | number)[] | undefined;
      if (!selected?.length) return;

      const id = selected[0];
      const geom = s['readFeature']?.getGeometry(id) as
        | { type: string; coordinates: [number, number][][] }
        | undefined;
      if (geom?.type !== 'Polygon') return;

      const ring = geom.coordinates[0];
      const coords = ring.slice(0, -1) as [number, number][];

      // ピクセル空間の重心を計算
      const pixels = coords.map(([lng, lat]) => this.project(lng, lat));
      const cx = pixels.reduce((s, p) => s + p.x, 0) / pixels.length;
      const cy = pixels.reduce((s, p) => s + p.y, 0) / pixels.length;

      this._scaleCenter = { x: cx, y: cy };
      this._scaleInitialDist = Math.hypot(event.containerX - cx, event.containerY - cy);
      this._scaleId = id;
      this._scaleInitialGeo = coords.map((c) => [c[0], c[1]] as [number, number]);

      setMapDraggability(false);
      return;
    }

    super.onDragStart(event, setMapDraggability);

    // rectangle コーナードラッグ状態の設定
    const s = this as unknown as Record<string, any>;
    const selected = s['selected'] as (string | number)[] | undefined;
    if (!selected?.length) return;

    if (s['dragCoordinate']?.isDragging()) {
      const id = selected[0];
      const props = s['readFeature']?.getProperties(id) as Record<string, unknown> | undefined;
      if (props?.['mode'] !== 'rectangle') return;

      const draggedIdx: number = s['dragCoordinate'].draggedCoordinate.index;
      const geom = s['readFeature'].getGeometry(id);
      const ring = geom.coordinates[0] as [number, number][];

      this._rectDragIdx = draggedIdx;
      this._rectDragOppGeo = ring[(draggedIdx + 2) % 4] as [number, number];

      const c0px = this.project(ring[draggedIdx][0], ring[draggedIdx][1]);
      const c1px = this.project(ring[(draggedIdx + 1) % 4][0], ring[(draggedIdx + 1) % 4][1]);
      const c3px = this.project(ring[(draggedIdx + 3) % 4][0], ring[(draggedIdx + 3) % 4][1]);

      this._rectDragU = normalize({ x: c1px.x - c0px.x, y: c1px.y - c0px.y });
      this._rectDragV = normalize({ x: c3px.x - c0px.x, y: c3px.y - c0px.y });
    }
  }

  override onDrag(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void): void {
    // Ctrl+S スケーリング
    if (
      this._scaleCenter !== undefined &&
      this._scaleInitialDist !== undefined &&
      this._scaleId !== undefined &&
      this._scaleInitialGeo !== undefined
    ) {
      if (!this.allowPointerEvent(this.pointerEvents.onDrag, event)) return;

      const cx = this._scaleCenter.x;
      const cy = this._scaleCenter.y;
      const currentDist = Math.hypot(event.containerX - cx, event.containerY - cy);

      // 重心に近すぎる場合は無視（ゼロ除算防止）
      if (this._scaleInitialDist < 1) {
        setMapDraggability(false);
        return;
      }

      const scale = currentDist / this._scaleInitialDist;

      // 初期座標をピクセル空間でスケールして地理座標に変換
      const newRing: [number, number][] = this._scaleInitialGeo.map(([lng, lat]) => {
        const px = this.project(lng, lat);
        const newX = cx + (px.x - cx) * scale;
        const newY = cy + (px.y - cy) * scale;
        const geo = this.unproject(newX, newY);
        return [geo.lng, geo.lat];
      });
      newRing.push(newRing[0]); // リングを閉じる

      const s = this as unknown as Record<string, any>;
      const result = s['mutateFeature']?.updatePolygon({
        featureId: this._scaleId,
        coordinateMutations: { type: 'replace', coordinates: [newRing] },
        context: { updateType: 'provisional' },
      });

      if (result) {
        const coords = result.geometry.coordinates;
        s['midPoints']?.updateAllInPlace({ featureCoordinates: coords });
        s['selectionPoints']?.updateAllInPlace({ featureCoordinates: coords });
        s['coordinatePoints']?.updateAllInPlace({
          featureId: this._scaleId,
          featureCoordinates: coords,
        });
      }

      setMapDraggability(false);
      return;
    }

    // rectangle カスタムリサイズ
    if (
      this._rectDragOppGeo &&
      this._rectDragU &&
      this._rectDragV &&
      this._rectDragIdx !== undefined
    ) {
      if (!this.allowPointerEvent(this.pointerEvents.onDrag, event)) return;

      const P: Pixel = { x: event.containerX, y: event.containerY };
      const oppPx: Pixel = this.project(this._rectDragOppGeo[0], this._rectDragOppGeo[1]);
      const u = this._rectDragU;
      const v = this._rectDragV;

      const d: Pixel = { x: oppPx.x - P.x, y: oppPx.y - P.y };
      const projU = dot(d, u);
      const projV = dot(d, v);

      const c1px: Pixel = { x: P.x + projU * u.x, y: P.y + projU * u.y };
      const c3px: Pixel = { x: P.x + projV * v.x, y: P.y + projV * v.y };

      const c0geo = this.unproject(P.x, P.y);
      const c1geo = this.unproject(c1px.x, c1px.y);
      const c3geo = this.unproject(c3px.x, c3px.y);

      const di = this._rectDragIdx;
      const newRing: [number, number][] = new Array(5);
      newRing[di]           = [c0geo.lng, c0geo.lat];
      newRing[(di + 1) % 4] = [c1geo.lng, c1geo.lat];
      newRing[(di + 2) % 4] = this._rectDragOppGeo;
      newRing[(di + 3) % 4] = [c3geo.lng, c3geo.lat];
      newRing[4]            = newRing[0];

      const s = this as unknown as Record<string, any>;
      const id = (s['selected'] as (string | number)[])[0];

      s['mutateFeature']?.updatePolygon({
        featureId: id,
        coordinateMutations: { type: 'replace', coordinates: [newRing] },
        context: { updateType: 'provisional' },
      });

      for (let i = 0; i < 4; i++) {
        s['selectionPoints']?.updateOneAtIndex(i, newRing[i]);
        s['coordinatePoints']?.updateOneAtIndex(id, i, newRing[i]);
      }

      setMapDraggability(false);
      return;
    }

    super.onDrag(event, setMapDraggability);
  }

  override onDragEnd(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    this._resetScale();
    this._resetRectDrag();
    super.onDragEnd(event, setMapDraggability);
  }

  override cleanUp(): void {
    this._resetScale();
    this._resetRectDrag();
    super.cleanUp();
  }
}
