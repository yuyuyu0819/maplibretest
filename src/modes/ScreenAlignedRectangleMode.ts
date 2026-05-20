import { TerraDrawRectangleMode } from 'terra-draw';
import type { TerraDrawMouseEvent, TerraDrawKeyboardEvent } from 'terra-draw';

// TerraDrawRectangleMode の private フィールドへのアクセス用型
// これらのフィールドは TypeScript では private だが、
// コンパイル後の JS では通常プロパティとして存在する
interface _RectInternals {
  currentRectangleId: string | number | undefined;
  startPosition: [number, number] | undefined;
  endPosition: [number, number] | undefined;
  drawType: 'click' | 'drag' | undefined;
  keyEvents: { cancel: string | null; finish: string | null };
  mutateFeature: {
    updatePolygon(args: {
      featureId: string | number;
      coordinateMutations: { type: 'replace'; coordinates: [number, number][][] };
      propertyMutations?: Record<string, unknown>;
      context: { updateType: string; action?: string };
    }): unknown;
  };
}

type Pixel = { x: number; y: number };

/**
 * 地図が回転していても画面の縦横軸に沿った矩形を描くモード。
 *
 * 標準の TerraDrawRectangleMode は地理座標で 4 隅を決めるため、
 * 地図回転時に矩形も回転して見える。このクラスは画面ピクセル座標で
 * 4 隅を決め unproject することで画面上常に傾かない矩形を実現する。
 */
export class ScreenAlignedRectangleMode extends TerraDrawRectangleMode {
  private _startPixel: Pixel | undefined = undefined;
  private _endPixel: Pixel | undefined = undefined;

  private get _i(): _RectInternals {
    return this as unknown as _RectInternals;
  }

  /** 画面4隅を unproject した Polygon 座標リングを返す */
  private screenRect(endX: number, endY: number): [number, number][][] {
    const s = this._startPixel!;
    const tl = this.unproject(s.x, s.y);
    const tr = this.unproject(endX, s.y);
    const br = this.unproject(endX, endY);
    const bl = this.unproject(s.x, endY);
    return [[
      [tl.lng, tl.lat],
      [tr.lng, tr.lat],
      [br.lng, br.lat],
      [bl.lng, bl.lat],
      [tl.lng, tl.lat],
    ]];
  }

  /** 描画中の Polygon を画面座標から計算した座標で上書きする */
  private applyScreenRect(endX: number, endY: number, finish: boolean): void {
    const i = this._i;
    if (!i.currentRectangleId || !this._startPixel) return;
    i.mutateFeature.updatePolygon({
      featureId: i.currentRectangleId,
      coordinateMutations: { type: 'replace', coordinates: this.screenRect(endX, endY) },
      propertyMutations: finish ? { currentlyDrawing: undefined } : {},
      context: finish ? { updateType: 'finish', action: 'draw' } : { updateType: 'provisional' },
    });
  }

  /** 描画完了の後処理（状態リセット + onFinish 発火） */
  private finishDrawing(): void {
    const i = this._i;
    const id = i.currentRectangleId;
    if (!id) return;
    i.currentRectangleId = undefined;
    i.startPosition = undefined;
    i.drawType = undefined;
    this._startPixel = undefined;
    this._endPixel = undefined;
    if (this.state === 'drawing') this.setStarted();
    this.onFinish(id, { mode: this.mode, action: 'draw' });
  }

  private isClickAllowed(event: TerraDrawMouseEvent): boolean {
    return (
      this.moveDrawAllowed() &&
      (
        (event.button === 'left' && this.allowPointerEvent(this.pointerEvents.leftClick, event)) ||
        (event.button === 'right' && this.allowPointerEvent(this.pointerEvents.rightClick, event)) ||
        (event.isContextMenu && this.allowPointerEvent(this.pointerEvents.contextMenu, event))
      )
    );
  }

  override onClick(event: TerraDrawMouseEvent): void {
    if (!this._startPixel) {
      // 1クリック目: 親クラスに feature 生成を委譲し、その後 startPixel を記録
      super.onClick(event);
      if (this._i.currentRectangleId) {
        this._startPixel = { x: event.containerX, y: event.containerY };
        this._endPixel = { x: event.containerX, y: event.containerY };
      }
    } else if (this.isClickAllowed(event)) {
      // 2クリック目: 画面座標で確定
      this.applyScreenRect(event.containerX, event.containerY, true);
      this.finishDrawing();
    }
  }

  override onMouseMove(event: TerraDrawMouseEvent): void {
    this._i.endPosition = [event.lng, event.lat];
    this._endPixel = { x: event.containerX, y: event.containerY };
    if (!this._startPixel || !this._i.currentRectangleId) return;
    this.applyScreenRect(event.containerX, event.containerY, false);
  }

  override onDragStart(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    super.onDragStart(event, setMapDraggability);
    if (this._i.currentRectangleId && !this._startPixel) {
      this._startPixel = { x: event.containerX, y: event.containerY };
      this._endPixel = { x: event.containerX, y: event.containerY };
    }
  }

  override onDrag(
    event: TerraDrawMouseEvent,

  ): void {
    if (!this.allowPointerEvent(this.pointerEvents.onDrag, event)) return;
    if (!this.dragDrawAllowed() || this._i.drawType !== 'drag') return;
    this._i.endPosition = [event.lng, event.lat];
    this._endPixel = { x: event.containerX, y: event.containerY };
    if (!this._startPixel || !this._i.currentRectangleId) return;
    this.applyScreenRect(event.containerX, event.containerY, false);
  }

  override onDragEnd(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (!this.allowPointerEvent(this.pointerEvents.onDragEnd, event)) return;
    if (!this.dragDrawAllowed() || this._i.drawType !== 'drag') return;
    if (!this._startPixel || !this._i.currentRectangleId) return;
    this.applyScreenRect(event.containerX, event.containerY, true);
    setMapDraggability(true);
    this.finishDrawing();
  }

  override onKeyUp(event: TerraDrawKeyboardEvent): void {
    const { cancel, finish } = this._i.keyEvents;
    if (event.key === cancel) {
      this.cleanUp();
    } else if (event.key === finish && this._startPixel && this._endPixel) {
      this.applyScreenRect(this._endPixel.x, this._endPixel.y, true);
      this.finishDrawing();
    }
  }

  override cleanUp(): void {
    this._startPixel = undefined;
    this._endPixel = undefined;
    super.cleanUp();
  }
}
