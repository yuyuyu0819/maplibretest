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
 * TerraDrawSelectMode を拡張し、rectangle フィーチャーの
 * 頂点ドラッグ時に回転状態を維持したままリサイズするモード。
 *
 * アルゴリズム:
 *   ドラッグ開始時に矩形の2つの辺方向（u, v 単位ベクトル）を保存。
 *   ドラッグ中はマウス位置→対角コーナー間のベクトルを u/v に射影し、
 *   隣接2コーナーを再計算することで向きを保ったままリサイズする。
 *
 * それ以外の操作（移動・回転・スケール）は親クラスに委譲。
 */
export class ScreenAlignedSelectMode extends TerraDrawSelectMode {
  private _rectDragOppGeo: [number, number] | undefined;
  private _rectDragU: Pixel | undefined; // C0→C1 方向の単位ベクトル（ピクセル空間）
  private _rectDragV: Pixel | undefined; // C0→C3 方向の単位ベクトル（ピクセル空間）
  private _rectDragIdx: number | undefined; // ドラッグ中のコーナーインデックス

  constructor(options: SelectOptions = {}) {
    super(options);
  }

  override onDragStart(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    super.onDragStart(event, setMapDraggability);

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

      // 対角コーナーの地理座標を保存（ドラッグ中は固定）
      this._rectDragIdx = draggedIdx;
      this._rectDragOppGeo = ring[(draggedIdx + 2) % 4] as [number, number];

      // 矩形の回転軸をピクセル空間で計算して保存
      const c0px = this.project(ring[draggedIdx][0], ring[draggedIdx][1]);
      const c1px = this.project(ring[(draggedIdx + 1) % 4][0], ring[(draggedIdx + 1) % 4][1]);
      const c3px = this.project(ring[(draggedIdx + 3) % 4][0], ring[(draggedIdx + 3) % 4][1]);

      this._rectDragU = normalize({ x: c1px.x - c0px.x, y: c1px.y - c0px.y });
      this._rectDragV = normalize({ x: c3px.x - c0px.x, y: c3px.y - c0px.y });
    }
  }

  override onDrag(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void): void {
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

      // マウス→対角コーナーのベクトルを u/v 軸に射影
      const d: Pixel = { x: oppPx.x - P.x, y: oppPx.y - P.y };
      const projU = dot(d, u);
      const projV = dot(d, v);

      // 新しい隣接2コーナーのピクセル位置
      const c1px: Pixel = { x: P.x + projU * u.x, y: P.y + projU * u.y };
      const c3px: Pixel = { x: P.x + projV * v.x, y: P.y + projV * v.y };

      // 4コーナーを地理座標へ変換
      const c0geo = this.unproject(P.x, P.y);
      const c1geo = this.unproject(c1px.x, c1px.y);
      const c3geo = this.unproject(c3px.x, c3px.y);

      // 元のリング順序を維持してコーナーを配置
      const di = this._rectDragIdx;
      const newRing: [number, number][] = new Array(5);
      newRing[di]            = [c0geo.lng, c0geo.lat];
      newRing[(di + 1) % 4]  = [c1geo.lng, c1geo.lat];
      newRing[(di + 2) % 4]  = this._rectDragOppGeo;   // 対角は固定（地理座標そのまま）
      newRing[(di + 3) % 4]  = [c3geo.lng, c3geo.lat];
      newRing[4]             = newRing[0];              // ポリゴン閉じ点

      const s = this as unknown as Record<string, any>;
      const id = (s['selected'] as (string | number)[])[0];

      s['mutateFeature']?.updatePolygon({
        featureId: id,
        coordinateMutations: { type: 'replace', coordinates: [newRing] },
        context: { updateType: 'provisional' },
      });

      // 選択ハンドルを全4頂点分同期
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
    this._resetRectDrag();
    super.onDragEnd(event, setMapDraggability);
  }

  override cleanUp(): void {
    this._resetRectDrag();
    super.cleanUp();
  }

  private _resetRectDrag(): void {
    this._rectDragOppGeo = undefined;
    this._rectDragU = undefined;
    this._rectDragV = undefined;
    this._rectDragIdx = undefined;
  }
}
