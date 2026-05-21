import { TerraDrawRectangleMode } from 'terra-draw';
import type { TerraDrawMouseEvent, TerraDrawKeyboardEvent } from 'terra-draw';

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

const CORNER_HIT_PX = 14;

function pDist(A: Pixel, B: Pixel): number {
  return Math.hypot(A.x - B.x, A.y - B.y);
}

/** 凸四角形の内部判定（スクリーン整列矩形用） */
function ptInQuad(P: Pixel, q: [Pixel, Pixel, Pixel, Pixel]): boolean {
  let sign: number | undefined;
  for (let i = 0; i < 4; i++) {
    const A = q[i];
    const B = q[(i + 1) % 4];
    const cross = (B.x - A.x) * (P.y - A.y) - (B.y - A.y) * (P.x - A.x);
    if (cross === 0) continue;
    const s = cross > 0 ? 1 : -1;
    if (sign === undefined) sign = s;
    else if (sign !== s) return false;
  }
  return sign !== undefined;
}

/**
 * 地図が回転していても画面の縦横軸に沿った矩形を描くモード。
 *
 * 【描画】クリック2回 or ドラッグで画面整列矩形を確定
 * 【再編集】rectangle モードのまま既存矩形に対して:
 *   コーナー付近をドラッグ → 対角固定でスクリーン整列リサイズ
 *   内部をドラッグ        → 形状全体を移動
 */
export class ScreenAlignedRectangleMode extends TerraDrawRectangleMode {
  private _startPixel: Pixel | undefined = undefined;
  private _endPixel: Pixel | undefined = undefined;

  // 既存矩形の再編集用
  private _editId: string | number | undefined;
  private _editMode: 'corner' | 'move' | undefined;
  private _editOppPx: Pixel | undefined;       // corner モード: 固定の対角ピクセル
  private _editDragStart: Pixel | undefined;
  private _editMoveCorners: [number, number][] | undefined; // move モード: 開始時の地理座標

  private get _i(): _RectInternals {
    return this as unknown as _RectInternals;
  }

  // ---- 描画ヘルパー ----

  private screenRect(endX: number, endY: number): [number, number][][] {
    const s = this._startPixel!;
    const tl = this.unproject(s.x, s.y);
    const tr = this.unproject(endX, s.y);
    const br = this.unproject(endX, endY);
    const bl = this.unproject(s.x, endY);
    return [[[tl.lng, tl.lat], [tr.lng, tr.lat], [br.lng, br.lat], [bl.lng, bl.lat], [tl.lng, tl.lat]]];
  }

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

  // ---- 再編集ヘルパー ----

  /** クリック/ドラッグ開始位置付近の確定済み矩形を探す */
  private findRectNearDrag(mouseX: number, mouseY: number): {
    id: string | number;
    cornerIdx: number | undefined; // 0-3、内部ヒットなら undefined
    cornersPx: [Pixel, Pixel, Pixel, Pixel];
    cornersGeo: [number, number][];
  } | undefined {
    const P: Pixel = { x: mouseX, y: mouseY };
    for (const feature of this.store.copyAll()) {
      if (
        feature.properties['mode'] !== this.mode ||
        feature.properties['currentlyDrawing'] ||
        feature.geometry.type !== 'Polygon'
      ) continue;
      const ring = feature.geometry.coordinates[0] as [number, number][];
      if (ring.length < 5) continue;
      const cornersGeo = ring.slice(0, 4) as [number, number][];
      const cornersPx: [Pixel, Pixel, Pixel, Pixel] = [
        this.project(cornersGeo[0][0], cornersGeo[0][1]),
        this.project(cornersGeo[1][0], cornersGeo[1][1]),
        this.project(cornersGeo[2][0], cornersGeo[2][1]),
        this.project(cornersGeo[3][0], cornersGeo[3][1]),
      ];
      // コーナー近傍チェック
      let minDist = Infinity;
      let cornerIdx: number | undefined;
      for (let i = 0; i < 4; i++) {
        const d = pDist(P, cornersPx[i]);
        if (d < minDist) { minDist = d; cornerIdx = i; }
      }
      if (minDist <= CORNER_HIT_PX) {
        return { id: feature.id as string | number, cornerIdx, cornersPx, cornersGeo };
      }
      // 内部チェック
      if (ptInQuad(P, cornersPx)) {
        return { id: feature.id as string | number, cornerIdx: undefined, cornersPx, cornersGeo };
      }
    }
    return undefined;
  }

  /** ドラッグ角と固定角からスクリーン整列ポリゴン座標を生成 */
  private editGeomFromCorners(dragged: Pixel, opp: Pixel): [number, number][][] {
    const minX = Math.min(dragged.x, opp.x);
    const maxX = Math.max(dragged.x, opp.x);
    const minY = Math.min(dragged.y, opp.y);
    const maxY = Math.max(dragged.y, opp.y);
    const tl = this.unproject(minX, minY);
    const tr = this.unproject(maxX, minY);
    const br = this.unproject(maxX, maxY);
    const bl = this.unproject(minX, maxY);
    return [[[tl.lng, tl.lat], [tr.lng, tr.lat], [br.lng, br.lat], [bl.lng, bl.lat], [tl.lng, tl.lat]]];
  }

  /** 現在のドラッグ位置でフィーチャーのジオメトリを更新する */
  private applyEditGeom(mouseX: number, mouseY: number): void {
    if (!this._editId) return;
    let coords: [number, number][][];
    if (this._editMode === 'corner' && this._editOppPx) {
      coords = this.editGeomFromCorners({ x: mouseX, y: mouseY }, this._editOppPx);
    } else if (this._editMode === 'move' && this._editMoveCorners && this._editDragStart) {
      const dx = mouseX - this._editDragStart.x;
      const dy = mouseY - this._editDragStart.y;
      const moved = this._editMoveCorners.map(([lng, lat]) => {
        const px = this.project(lng, lat);
        const g = this.unproject(px.x + dx, px.y + dy);
        return [g.lng, g.lat] as [number, number];
      });
      coords = [[...moved, moved[0]]];
    } else return;
    this.store.updateGeometry([{
      id: this._editId,
      geometry: { type: 'Polygon', coordinates: coords },
    }]);
  }

  private resetEditState(): void {
    this._editId = undefined;
    this._editMode = undefined;
    this._editOppPx = undefined;
    this._editDragStart = undefined;
    this._editMoveCorners = undefined;
  }

  // ---- TerraDrawRectangleMode オーバーライド ----

  override onClick(event: TerraDrawMouseEvent): void {
    if (!this._startPixel && !this._editId) {
      // 既存矩形をクリック → 新規描画を開始しない
      if (this.findRectNearDrag(event.containerX, event.containerY)) return;
    }
    if (!this._startPixel) {
      super.onClick(event);
      if (this._i.currentRectangleId) {
        this._startPixel = { x: event.containerX, y: event.containerY };
        this._endPixel = { x: event.containerX, y: event.containerY };
      }
    } else if (this.isClickAllowed(event)) {
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
    if (!this._startPixel && !this._editId) {
      // 既存矩形へのドラッグ → 再編集モード開始
      const found = this.findRectNearDrag(event.containerX, event.containerY);
      if (found) {
        this._editId = found.id;
        this._editDragStart = { x: event.containerX, y: event.containerY };
        if (found.cornerIdx !== undefined) {
          // コーナードラッグ: 対角を固定
          const oppIdx = (found.cornerIdx + 2) % 4;
          this._editOppPx = found.cornersPx[oppIdx];
          this._editMode = 'corner';
        } else {
          // 内部ドラッグ: 移動
          this._editMoveCorners = found.cornersGeo;
          this._editMode = 'move';
        }
        setMapDraggability(false);
        return;
      }
    }
    // 通常の描画ドラッグ
    super.onDragStart(event, setMapDraggability);
    if (this._i.currentRectangleId && !this._startPixel) {
      this._startPixel = { x: event.containerX, y: event.containerY };
      this._endPixel = { x: event.containerX, y: event.containerY };
    }
  }

  override onDrag(event: TerraDrawMouseEvent): void {
    if (this._editId) {
      this.applyEditGeom(event.containerX, event.containerY);
      return;
    }
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
    if (this._editId) {
      this.applyEditGeom(event.containerX, event.containerY);
      this.resetEditState();
      setMapDraggability(true);
      return;
    }
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
    this.resetEditState();
    this._startPixel = undefined;
    this._endPixel = undefined;
    super.cleanUp();
  }
}
