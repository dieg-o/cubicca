import { describe, expect, it } from "vitest";

import type { Point } from "@/lib/geometry";

import {
  MEASUREMENT_META,
  VALUE_MISMATCH_EPSILON,
  computeMeasurementValue,
  createMeasurementSchema,
  formatMeasurement,
  parseStoredGeometry,
} from "./measurement";

/**
 * El motor ya está testeado aparte; acá se prueba la capa de arriba: que cada
 * herramienta use LA fórmula que le corresponde, que el schema no deje entrar
 * una medición incoherente, y que lo que se relee de la base se valide.
 *
 * Los números salen de un plano calibrado a 0,05 m por unidad de user-space
 * (una cota de 100 unidades que el usuario declaró de 5 m). Con ese factor las
 * cuentas dan redondas y un error se ve a ojo.
 */

const FACTOR = 0.05;

/** 100 unidades de user-space = 5 m con FACTOR. */
const CORRIDA: Point[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
];

/** 20×20 unidades = 1 m de lado, 1 m² con FACTOR. */
const CUADRADO: Point[] = [
  { x: 0, y: 0 },
  { x: 20, y: 0 },
  { x: 20, y: 20 },
  { x: 0, y: 20 },
];

describe("computeMeasurementValue", () => {
  it("LARGO_CONTINUO devuelve metros: 100 u × 0,05 = 5 m", () => {
    expect(computeMeasurementValue("LARGO_CONTINUO", CORRIDA, FACTOR, null)).toBeCloseTo(5, 12);
  });

  it("LARGO_CONTINUO suma los segmentos y no cierra la figura", () => {
    // Tres vértices en L: 100 + 100 unidades = 10 m. Si cerrara, daría más.
    const codo: Point[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];

    expect(computeMeasurementValue("LARGO_CONTINUO", codo, FACTOR, null)).toBeCloseTo(10, 12);
  });

  it("MURO devuelve m²: los mismos 5 m de corrida por 2,40 de alto = 12 m²", () => {
    expect(computeMeasurementValue("MURO", CORRIDA, FACTOR, 2.4)).toBeCloseTo(12, 12);
  });

  it("MURO es el LARGO por el alto, exactamente", () => {
    // La relación que hace que un muro sea una polilínea con altura y no otra
    // cosa: si mañana difieren, uno de los dos caminos se tocó de más.
    const largo = computeMeasurementValue("LARGO_CONTINUO", CORRIDA, FACTOR, null);

    expect(computeMeasurementValue("MURO", CORRIDA, FACTOR, 3)).toBeCloseTo(largo * 3, 12);
  });

  it("AREA lleva el factor al CUADRADO: 400 u² × 0,05² = 1 m², no 20", () => {
    // El error clásico de esta feature. 20 sería el resultado de aplicar el
    // factor una sola vez, y es un número lo bastante creíble como para pasar
    // desapercibido en un presupuesto.
    const area = computeMeasurementValue("AREA", CUADRADO, FACTOR, null);

    expect(area).toBeCloseTo(1, 12);
    expect(area).not.toBeCloseTo(20, 6);
  });

  it("AREA cierra el polígono sola y no depende del sentido de marcado", () => {
    const antihorario = computeMeasurementValue("AREA", CUADRADO, FACTOR, null);
    const horario = computeMeasurementValue("AREA", [...CUADRADO].reverse(), FACTOR, null);

    expect(horario).toBeCloseTo(antihorario, 12);
  });

  it("un MURO sin alto es un error controlado, no un NaN persistido", () => {
    expect(() => computeMeasurementValue("MURO", CORRIDA, FACTOR, null)).toThrow(/alto mayor a cero/);
    expect(() => computeMeasurementValue("MURO", CORRIDA, FACTOR, 0)).toThrow(/alto mayor a cero/);
    expect(() => computeMeasurementValue("MURO", CORRIDA, FACTOR, -2.4)).toThrow(
      /alto mayor a cero/
    );
    expect(() => computeMeasurementValue("MURO", CORRIDA, FACTOR, Number.NaN)).toThrow(
      /alto mayor a cero/
    );
  });

  it("hereda las guardas del motor cuando faltan vértices", () => {
    expect(() => computeMeasurementValue("LARGO_CONTINUO", [{ x: 0, y: 0 }], FACTOR, null)).toThrow(
      /al menos 2 puntos/
    );
    expect(() => computeMeasurementValue("AREA", CORRIDA, FACTOR, null)).toThrow(
      /al menos 3 puntos/
    );
  });

  it("es determinista: el preview del cliente y el valor del server no pueden divergir", () => {
    // Las dos puntas llaman a esta misma función. El test fija esa propiedad —
    // que es lo que el server action verifica en runtime con el epsilon.
    const cliente = computeMeasurementValue("AREA", CUADRADO, FACTOR, null);
    const servidor = computeMeasurementValue("AREA", CUADRADO, FACTOR, null);

    expect(Math.abs(cliente - servidor) / servidor).toBeLessThanOrEqual(VALUE_MISMATCH_EPSILON);
  });

  it("el epsilon es lo bastante chico como para delatar una fórmula distinta", () => {
    // Contraprueba del test anterior: si un lado se quedara con la fórmula sin
    // el cuadrado, el drift tiene que superar el umbral por varios órdenes.
    const correcto = computeMeasurementValue("AREA", CUADRADO, FACTOR, null);
    const sinCuadrado = 400 * FACTOR;

    expect(Math.abs(correcto - sinCuadrado) / correcto).toBeGreaterThan(VALUE_MISMATCH_EPSILON);
  });
});

describe("MEASUREMENT_META", () => {
  it("los minPoints coinciden con lo que el motor exige de verdad", () => {
    // El schema valida contra esta tabla; el motor tira por su cuenta. Si se
    // desincronizan, el usuario ve un error de sistema en vez de uno de forma.
    expect(MEASUREMENT_META.LARGO_CONTINUO.minPoints).toBe(2);
    expect(MEASUREMENT_META.MURO.minPoints).toBe(2);
    expect(MEASUREMENT_META.AREA.minPoints).toBe(3);
  });

  it("cada herramienta declara la unidad que devuelve su fórmula", () => {
    expect(MEASUREMENT_META.LARGO_CONTINUO.unit).toBe("m");
    expect(MEASUREMENT_META.MURO.unit).toBe("m²");
    expect(MEASUREMENT_META.AREA.unit).toBe("m²");
  });

  it("solo el área es una figura cerrada", () => {
    expect(MEASUREMENT_META.AREA.closed).toBe(true);
    expect(MEASUREMENT_META.LARGO_CONTINUO.closed).toBe(false);
    expect(MEASUREMENT_META.MURO.closed).toBe(false);
  });
});

describe("createMeasurementSchema", () => {
  const PLAN_ID = "3f8a1c2e-5b7d-4e9f-8a1b-2c3d4e5f6a7b";

  const base = {
    planId: PLAN_ID,
    type: "LARGO_CONTINUO" as const,
    pageIndex: 0,
    points: CORRIDA,
    alto: null,
    label: null,
    previewValue: 5,
  };

  it("acepta una medición bien formada", () => {
    expect(createMeasurementSchema.safeParse(base).success).toBe(true);
  });

  it("un MURO sin alto no pasa, y con alto sí", () => {
    const muro = { ...base, type: "MURO" as const, previewValue: 12 };

    expect(createMeasurementSchema.safeParse(muro).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...muro, alto: 2.4 }).success).toBe(true);
  });

  it("un alto en un tipo que no es MURO tampoco pasa", () => {
    // No es quisquilloso: un alto en un área significa que la UI mandó estado
    // viejo, y ese alto no se usaría en la cuenta pero sí quedaría persistido.
    expect(createMeasurementSchema.safeParse({ ...base, alto: 2.4 }).success).toBe(false);
    expect(
      createMeasurementSchema.safeParse({
        ...base,
        type: "AREA" as const,
        points: CUADRADO,
        alto: 2.4,
      }).success
    ).toBe(false);
  });

  it("un AREA con 2 puntos no pasa, con 3 sí", () => {
    const area = { ...base, type: "AREA" as const, previewValue: 1 };

    expect(createMeasurementSchema.safeParse(area).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...area, points: CUADRADO }).success).toBe(true);
  });

  it("una polilínea de 1 punto no pasa", () => {
    expect(createMeasurementSchema.safeParse({ ...base, points: [{ x: 0, y: 0 }] }).success).toBe(
      false
    );
  });

  it("corta arriba de 500 vértices", () => {
    const puntos = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i, y: 0 }));

    expect(createMeasurementSchema.safeParse({ ...base, points: puntos(500) }).success).toBe(true);
    expect(createMeasurementSchema.safeParse({ ...base, points: puntos(501) }).success).toBe(false);
  });

  it("rechaza coordenadas que no son números finitos", () => {
    const infectada = [{ x: 0, y: 0 }, { x: Number.NaN, y: 10 }];

    expect(createMeasurementSchema.safeParse({ ...base, points: infectada }).success).toBe(false);
  });

  it("rechaza un planId que no es uuid y un pageIndex negativo", () => {
    expect(createMeasurementSchema.safeParse({ ...base, planId: "el-plano" }).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...base, pageIndex: -1 }).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...base, pageIndex: 1.5 }).success).toBe(false);
  });

  it("rechaza un previewValue que no es un número positivo", () => {
    expect(createMeasurementSchema.safeParse({ ...base, previewValue: 0 }).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...base, previewValue: -5 }).success).toBe(false);
  });

  it("recorta la etiqueta y la corta en 120 caracteres", () => {
    const parsed = createMeasurementSchema.safeParse({ ...base, label: "  Contrapiso  " });

    expect(parsed.success && parsed.data.label).toBe("Contrapiso");
    expect(createMeasurementSchema.safeParse({ ...base, label: "x".repeat(121) }).success).toBe(
      false
    );
  });

  it("un alto absurdo no pasa: 0, negativo o más de 100 m", () => {
    const muro = { ...base, type: "MURO" as const, previewValue: 12 };

    expect(createMeasurementSchema.safeParse({ ...muro, alto: 0 }).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...muro, alto: -2.4 }).success).toBe(false);
    expect(createMeasurementSchema.safeParse({ ...muro, alto: 101 }).success).toBe(false);
  });
});

describe("parseStoredGeometry", () => {
  it("relee una geometría válida de la base", () => {
    expect(parseStoredGeometry(CORRIDA)).toEqual(CORRIDA);
  });

  it("devuelve null ante cualquier cosa que no sea una lista de puntos", () => {
    // La columna es `Json`: la base no garantiza nada sobre lo que hay adentro,
    // y una fila vieja o pisada a mano no puede romper el render de la lista.
    expect(parseStoredGeometry(null)).toBeNull();
    expect(parseStoredGeometry("[]")).toBeNull();
    expect(parseStoredGeometry([{ x: 0 }])).toBeNull();
    expect(parseStoredGeometry([{ x: 0, y: 0 }])).toBeNull();
    expect(parseStoredGeometry({ x: 0, y: 0 })).toBeNull();
  });
});

describe("formatMeasurement", () => {
  it("usa coma decimal y la unidad de cada tipo", () => {
    expect(formatMeasurement(5, "LARGO_CONTINUO")).toBe("5,00 m");
    expect(formatMeasurement(12.5, "MURO")).toBe("12,50 m²");
    expect(formatMeasurement(1, "AREA")).toBe("1,00 m²");
  });

  it("redondea a dos decimales, que es como se presupuesta", () => {
    expect(formatMeasurement(3.14159, "LARGO_CONTINUO")).toBe("3,14 m");
    expect(formatMeasurement(0.005, "AREA")).toBe("0,01 m²");
  });
});
