import { describe, expect, it } from 'vitest';
import { clampSize, dragFromCentre, dragFromCorner, keySize, sizeRange, snapSize, wheelSize, zoomKeySize } from '../src/lib/resize';

describe('resizing an orb by hand', () => {
  const window = sizeRange('appearance.orbSize');
  const floating = sizeRange('appearance.floatingOrbSize');

  it('keeps to the ranges and steps of the settings the sizes are saved as', () => {
    expect(window).toEqual({ min: 50, max: 200, step: 5 });
    expect(floating).toEqual({ min: 75, max: 300, step: 5 });
    expect(clampSize(20, window)).toBe(50);
    expect(clampSize(999, floating)).toBe(300);
    expect(snapSize(117.4, window)).toBe(115);
    expect(snapSize(118, window)).toBe(120);
    expect(snapSize(212, window)).toBe(200);
  });

  it('grows with ⌥ and scrolling up, or pinching out - and a pinch counts for more per event', () => {
    const up = wheelSize(100, { deltaY: -50, deltaMode: 0, ctrlKey: false });
    const down = wheelSize(100, { deltaY: 50, deltaMode: 0, ctrlKey: false });
    expect(up).toBeGreaterThan(100);
    expect(down).toBeLessThan(100);
    expect(up * down).toBeCloseTo(100 * 100); // up then down comes back to where it was
    const pinch = wheelSize(100, { deltaY: -5, deltaMode: 0, ctrlKey: true });
    const scroll = wheelSize(100, { deltaY: -5, deltaMode: 0, ctrlKey: false });
    expect(pinch - 100).toBeGreaterThan(scroll - 100);
    expect(wheelSize(100, { deltaY: -3, deltaMode: 1, ctrlKey: false })).toBeCloseTo(wheelSize(100, { deltaY: -48, deltaMode: 0, ctrlKey: false })); // lines
  });

  it("drags the window Orb's rim with the pointer: both sides move, so twice the pointer's way out", () => {
    // 220 px across at 100%: 2.2 px a percent. The pointer goes 22 px further from the centre: 44 px wider, 20%.
    expect(dragFromCentre(100, 2.2, 90, 112)).toBeCloseTo(120);
    expect(dragFromCentre(100, 2.2, 90, 68)).toBeCloseTo(80);
  });

  it("drags the floating orb away from its corner, along the diagonal - and not when the pointer goes along the corner's edge", () => {
    const away = { x: -1, y: -1 }; // pinned bottom-right: left and up grow it
    // 0.48 pt a percent. 24 pt left and 24 pt up: the handle moved 24 pt each way, so the orb grew 24 pt, 50%.
    expect(dragFromCorner(100, 0.48, -24, -24, away)).toBeCloseTo(150);
    expect(dragFromCorner(100, 0.48, 24, 24, away)).toBeCloseTo(50);
    expect(dragFromCorner(100, 0.48, -24, 24, away)).toBeCloseTo(100); // sideways along the diagonal's normal: no change
    expect(dragFromCorner(100, 0.48, 24, 24, { x: 1, y: 1 })).toBeCloseTo(150); // pinned top-left: right and down grow it
  });

  it('steps with the arrow keys on the handle, and jumps to the ends with Home and End', () => {
    expect(keySize(100, 'ArrowUp', window)).toBe(105);
    expect(keySize(100, 'ArrowLeft', window)).toBe(95);
    expect(keySize(198, 'ArrowRight', window)).toBe(200);
    expect(keySize(100, 'Home', window)).toBe(50);
    expect(keySize(100, 'End', floating)).toBe(300);
    expect(keySize(100, 'a', window)).toBeNull();
  });
});

describe('the text size, with ⌘+, ⌘− and ⌘0', () => {
  const text = sizeRange('appearance.textSize');

  it('steps like a browser zooms, within the setting\'s range - with or without shift', () => {
    expect(text).toEqual({ min: 75, max: 200, step: 5 });
    expect(zoomKeySize(100, '=', text)).toBe(110);
    expect(zoomKeySize(100, '+', text)).toBe(110); // ⌘⇧= on most keyboards
    expect(zoomKeySize(100, '-', text)).toBe(90);
    expect(zoomKeySize(100, '_', text)).toBe(90);
    expect(zoomKeySize(195, '=', text)).toBe(200);
    expect(zoomKeySize(80, '-', text)).toBe(75);
    expect(zoomKeySize(150, '0', text)).toBe(100);
    expect(zoomKeySize(100, 'k', text)).toBeNull();
  });
});
