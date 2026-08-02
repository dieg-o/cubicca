import { describe, expect, it } from "vitest";

import {
  applyScaleArea,
  applyScaleLength,
  distance,
  polygonArea,
  polylineLength,
  scaleFactorFromCalibration,
  toMeters,
  type Point,
} from "./index";

/**
 * Casos conocidos, elegidos para que un error se vea a ojo: 3-4-5, un cuadrado
 * de 2×2, un triángulo de base 4 y altura 3. Si una de estas cuentas da mal, el
 * número está mal, no el test.
 *
 * Nada de mocks ni de fixtures: el motor es puro, así que un test es la cuenta
 * y su resultado.
 */

describe("distance", () => {
  it("resuelve el triángulo 3-4-5", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("es simétrica y da 0 para el mismo punto", () => {
    const a: Point = { x: 12.5, y: -3 };
    const b: Point = { x: -4, y: 8.25 };

    expect(distance(a, b)).toBeCloseTo(distance(b, a), 12);
    expect(distance(a, a)).toBe(0);
  });

  it("rechaza coordenadas que no son números finitos", () => {
    expect(() => distance({ x: 0, y: 0 }, { x: Number.NaN, y: 1 })).toThrow(/finito/);
  });
});

describe("polylineLength", () => {
  it("suma los dos catetos del 3-4-5 (7), que no es la hipotenusa (5)", () => {
    // El caso que separa una polilínea de una distancia punto a punto: los
    // mismos extremos, distinto recorrido.
    const codo: Point[] = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 3, y: 4 },
    ];

    expect(polylineLength(codo)).toBe(7);
    expect(distance(codo[0], codo[2])).toBe(5);
  });

  it("un cuadrado unitario marcado abierto mide 3, no 4", () => {
    // No cerramos la figura: el usuario marcó 3 segmentos, no 4.
    expect(
      polylineLength([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ])
    ).toBe(3);
  });

  it("con menos de 2 puntos es un error controlado", () => {
    expect(() => polylineLength([{ x: 0, y: 0 }])).toThrow(/al menos 2 puntos/);
    expect(() => polylineLength([])).toThrow(/al menos 2 puntos/);
  });
});

describe("polygonArea", () => {
  it("un cuadrado de 2×2 da 4", () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 2, y: 2 },
        { x: 0, y: 2 },
      ])
    ).toBe(4);
  });

  it("un hastial de base 4 y altura 3 da 6", () => {
    expect(
      polygonArea([
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 2, y: 3 },
      ])
    ).toBe(6);
  });

  it("no depende del sentido en que se marcaron los vértices", () => {
    const horario: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 2 },
      { x: 2, y: 2 },
      { x: 2, y: 0 },
    ];

    // El shoelace de este recorrido da -4; el área es 4 igual.
    expect(polygonArea(horario)).toBe(4);
  });

  it("con menos de 3 puntos es un error controlado", () => {
    expect(() =>
      polygonArea([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ])
    ).toThrow(/al menos 3 puntos/);
  });
});

describe("toMeters", () => {
  it("convierte cm y mm a metros", () => {
    expect(toMeters(90, "cm")).toBeCloseTo(0.9, 12);
    expect(toMeters(1500, "mm")).toBeCloseTo(1.5, 12);
  });

  it("deja los metros como están", () => {
    expect(toMeters(2.4, "m")).toBe(2.4);
  });
});

describe("scaleFactorFromCalibration", () => {
  it("100 unidades PDF que son 5 m dan 0,05 m por unidad", () => {
    expect(scaleFactorFromCalibration(100, 5)).toBeCloseTo(0.05, 12);
  });

  it("ida y vuelta: aplicar el factor a la misma distancia devuelve la cota", () => {
    const pdfDistance = 100;
    const factor = scaleFactorFromCalibration(pdfDistance, 5);

    expect(applyScaleLength(pdfDistance, factor)).toBeCloseTo(5, 12);
  });

  it("una cota en cm da el mismo factor que la misma cota en metros", () => {
    // El usuario tipea 500 cm o 5 m: es la misma pared.
    expect(scaleFactorFromCalibration(100, toMeters(500, "cm"))).toBeCloseTo(
      scaleFactorFromCalibration(100, toMeters(5, "m")),
      12
    );
  });

  it("no depende del zoom: los mismos puntos en user-space dan el mismo factor", () => {
    // Es el invariante que sostiene todo el TD. Acá se prueba la mitad
    // aritmética; la otra mitad —que el click a 100% y a 250% de zoom caiga en
    // el mismo punto de user-space— la prueba el E2E contra el browser.
    const a: Point = { x: 120.5, y: 300.25 };
    const b: Point = { x: 420.5, y: 300.25 };

    expect(scaleFactorFromCalibration(distance(a, b), 6)).toBeCloseTo(0.02, 12);
  });

  it("dos puntos en el mismo lugar son un error controlado, no un Infinity", () => {
    expect(() => scaleFactorFromCalibration(0, 5)).toThrow(/separados/);
    expect(() => scaleFactorFromCalibration(-3, 5)).toThrow(/separados/);
  });

  it("una cota real de 0 o negativa es un error controlado", () => {
    expect(() => scaleFactorFromCalibration(100, 0)).toThrow(/mayor a cero/);
  });
});

describe("applyScaleLength / applyScaleArea", () => {
  it("el área lleva el factor al cuadrado: 400 unidades² con 0,05 son 1 m²", () => {
    expect(applyScaleArea(400, 0.05)).toBeCloseTo(1, 12);
  });

  it("un cuadrado de 20×20 en el PDF calibrado a 0,05 mide 1 m de lado y 1 m²", () => {
    // La coherencia entre las dos fórmulas, sobre la misma figura.
    const cuadrado: Point[] = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 },
    ];
    const factor = 0.05;

    expect(applyScaleLength(distance(cuadrado[0], cuadrado[1]), factor)).toBeCloseTo(1, 12);
    expect(applyScaleArea(polygonArea(cuadrado), factor)).toBeCloseTo(1, 12);
  });
});
