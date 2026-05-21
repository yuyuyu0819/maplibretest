import { TerraDrawSelectMode } from 'terra-draw';
import type { TerraDrawMouseEvent } from 'terra-draw';

type SelectOptions = ConstructorParameters<typeof TerraDrawSelectMode>[0];
type Pixel = { x: number; y: number };

/**
 * TerraDrawSelectMode を拡張し、rectangle フィーチャーの
 * 頂点ドラッグ時もスクリーン整列を維持するモード。
 *
 * - 対角コーナーを固定し、ドラッグ位置 + 固定コーナーの
 *   ピクセル bbox から画面整列矩形を再計算して適用する。
 * - それ以外の操作（移動・回転・スケール）は親クラスに委譲。
 */
export class ScreenAlignedSelectMode extends TerraDrawSelectMode {
  private _rectDragOppGeo: [number, number] | undefined;

  constructor(options: SelectOptions = {}) {
    super(options);
  }

  override onDragStart(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    super.onDragStart(event, setMapDraggability);

    // super が dragCoordinate.startDragging を呼んだ後に対角コーナーを保存
    const s = this as unknown as Record<string, any>;
    const selected = s['selected'] as (string | number)[] | undefined;
    if (!selected?.length) return;

    if (s['dragCoordinate']?.isDragging()) {
      const id = selected[0];
      const props = s['readFeature']?.getProperties(id) as Record<string, unknown> | undefined;
      if (props?.['mode'] === 'rectangle') {
        const draggedIdx: number = s['dragCoordinate'].draggedCoordinate.index;
        const geom = s['readFeature'].getGeometry(id);
        const ring = geom.coordinates[0] as [number, number][];
        const oppIdx = (draggedIdx + 2) % 4;
        this._rectDragOppGeo = ring[oppIdx] as [number, number];
      }
    }
  }

  override onDrag(event: TerraDrawMouseEvent, setMapDraggability: (enabled: boolean) => void): void {
    // rectangle の頂点ドラッグ中はスクリーン整列ロジックで処理
    if (this._rectDragOppGeo) {
      if (!this.allowPointerEvent(this.pointerEvents.onDrag, event)) return;

      const oppPx: Pixel = this.project(this._rectDragOppGeo[0], this._rectDragOppGeo[1]);

      const minX = Math.min(event.containerX, oppPx.x);
      const maxX = Math.max(event.containerX, oppPx.x);
      const minY = Math.min(event.containerY, oppPx.y);
      const maxY = Math.max(event.containerY, oppPx.y);

      const tl = this.unproject(minX, minY);
      const tr = this.unproject(maxX, minY);
      const br = this.unproject(maxX, maxY);
      const bl = this.unproject(minX, maxY);

      const newRing: [number, number][] = [
        [tl.lng, tl.lat],
        [tr.lng, tr.lat],
        [br.lng, br.lat],
        [bl.lng, bl.lat],
        [tl.lng, tl.lat],
      ];

      const s = this as unknown as Record<string, any>;
      const id = (s['selected'] as (string | number)[])[0];

      // ポリゴンジオメトリを更新（provisional）
      s['mutateFeature']?.updatePolygon({
        featureId: id,
        coordinateMutations: { type: 'replace', coordinates: [newRing] },
        context: { updateType: 'provisional' },
      });

      // 選択ハンドル（コーナー小丸）を全4頂点分同期
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
    this._rectDragOppGeo = undefined;
    super.onDragEnd(event, setMapDraggability);
  }

  override cleanUp(): void {
    this._rectDragOppGeo = undefined;
    super.cleanUp();
  }
}
