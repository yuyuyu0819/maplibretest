import { TerraDrawCircleMode } from 'terra-draw';
import type { TerraDrawMouseEvent, TerraDrawKeyboardEvent } from 'terra-draw';

// TerraDrawCircleMode の private フィールドへのアクセス用型
interface _CircleInternals {
  center: [number, number] | undefined;
  endPosition: [number, number] | undefined;
  currentCircleId: string | number | undefined;
  drawType: 'click' | 'drag' | undefined;
  cursorMovedAfterInitialCursorDown: boolean;
  keyEvents: { cancel: string | null; finish: string | null };
}

type Pixel = { x: number; y: number };

const SEGMENTS = 64;

/**
 * TerraDrawCircleMode を継承し、回転楕円の描画を追加するモード。
 *
 * 描画フロー (クリック操作):
 *   1クリック目: 中心を設定（親クラスに委譲）
 *   マウス移動:  円でプレビュー
 *   2クリック目: 長軸を確定（中心→クリック位置の方向が回転角、距離が長半径）
 *   マウス移動:  長軸固定で楕円プレビュー（短半径をマウスで調整）
 *   3クリック目: 短半径を確定 → 楕円完成
 *
 * ドラッグ操作の場合はドラッグ終了が「長軸の確定」になり、
 * その後クリックで短半径を確定する。
 */
export class RotatableCircleMode extends TerraDrawCircleMode {
  private _radiusFixed = false;
  private _radiusGeo: [number, number] | undefined; // 長軸端点（地理座標）

  private get _i(): _CircleInternals {
    return this as unknown as _CircleInternals;
  }

  /** ピクセル座標で楕円を計算し、地理座標のリングとして返す */
  private computeEllipse(
    center: Pixel,
    a: number,
    b: number,
    phi: number,
  ): [number, number][][] {
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const ring: [number, number][] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const t = (2 * Math.PI * i) / SEGMENTS;
      const px = center.x + a * Math.cos(t) * cosPhi - b * Math.sin(t) * sinPhi;
      const py = center.y + a * Math.cos(t) * sinPhi + b * Math.sin(t) * cosPhi;
      const { lng, lat } = this.unproject(px, py);
      ring.push([lng, lat]);
    }
    return [ring];
  }

  /** 長軸パラメータ（長半径 a、回転角 phi、中心ピクセル）を返す */
  private getMajorParams(): { a: number; phi: number; center: Pixel } {
    const [cLng, cLat] = this._i.center!;
    const center = this.project(cLng, cLat);
    const radius = this.project(this._radiusGeo![0], this._radiusGeo![1]);
    const dx = radius.x - center.x;
    const dy = radius.y - center.y;
    return {
      a: Math.max(1, Math.sqrt(dx * dx + dy * dy)),
      phi: Math.atan2(dy, dx),
      center,
    };
  }

  /** 現在のマウス位置から短半径を計算する（長軸への垂直成分） */
  private getMinorB(mouseX: number, mouseY: number, center: Pixel, phi: number): number {
    const dx = mouseX - center.x;
    const dy = mouseY - center.y;
    return Math.max(1, Math.abs(-dx * Math.sin(phi) + dy * Math.cos(phi)));
  }

  /** 楕円ジオメトリを更新する */
  private applyEllipse(mouseX: number, mouseY: number): void {
    const id = this._i.currentCircleId;
    if (!id || !this._i.center || !this._radiusGeo) return;
    const { a, phi, center } = this.getMajorParams();
    const b = this.getMinorB(mouseX, mouseY, center, phi);
    this.store.updateGeometry([{
      id,
      geometry: { type: 'Polygon', coordinates: this.computeEllipse(center, a, b, phi) },
    }]);
  }

  /** 楕円を確定して描画を終了する */
  private finishEllipse(mouseX: number, mouseY: number): void {
    const id = this._i.currentCircleId;
    if (!id) return;
    this.applyEllipse(mouseX, mouseY);
    this.store.updateProperty([{ id, property: 'currentlyDrawing', value: null }]);
    // 親クラスの内部状態をリセット
    this._i.cursorMovedAfterInitialCursorDown = false;
    this._i.center = undefined;
    this._i.currentCircleId = undefined;
    this._i.drawType = undefined;
    this._radiusFixed = false;
    this._radiusGeo = undefined;
    if (this.state === 'drawing') this.setStarted();
    this.onFinish(id, { mode: this.mode, action: 'draw' });
  }

  override onClick(event: TerraDrawMouseEvent): void {
    if (!this._i.center) {
      // 1クリック目: 親クラスに委譲（beginDrawing が center を設定する）
      super.onClick(event);
    } else if (!this._radiusFixed) {
      // 2クリック目: 長軸を確定して回転フェーズへ
      if (this._i.currentCircleId !== undefined) {
        this._radiusGeo = [event.lng, event.lat];
        this._radiusFixed = true;
      }
    } else {
      // 3クリック目: 短半径を確定して楕円完成
      this.finishEllipse(event.containerX, event.containerY);
    }
  }

  override onMouseMove(event: TerraDrawMouseEvent): void {
    if (!this._radiusFixed) {
      // 長軸設定前: 親クラスに委譲（円プレビュー）
      super.onMouseMove(event);
    } else {
      // 長軸確定後: 楕円プレビュー
      this.applyEllipse(event.containerX, event.containerY);
    }
  }

  override onDrag(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (!this._radiusFixed) {
      super.onDrag(event, setMapDraggability);
    }
  }

  override onDragEnd(
    event: TerraDrawMouseEvent,
    setMapDraggability: (enabled: boolean) => void,
  ): void {
    if (
      this._i.drawType === 'drag' &&
      this._i.currentCircleId !== undefined &&
      !this._radiusFixed
    ) {
      // ドラッグ終了: 長軸を確定して回転フェーズへ
      this._radiusGeo = [event.lng, event.lat];
      this._radiusFixed = true;
      setMapDraggability(true);
    }
  }

  override onKeyUp(event: TerraDrawKeyboardEvent): void {
    if (event.key === this._i.keyEvents.cancel) {
      this.cleanUp();
    }
  }

  override cleanUp(): void {
    this._radiusFixed = false;
    this._radiusGeo = undefined;
    super.cleanUp();
  }
}
