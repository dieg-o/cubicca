import { NextResponse } from "next/server";

import { prisma } from "@/lib/db/prisma";

// Nunca prerenderizar: toca la base, tiene que resolverse en request time.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const organizations = await prisma.organization.count();

    return NextResponse.json({
      ok: true,
      organizations,
      connection: "pooler:6543",
    });
  } catch (error) {
    // Detalle técnico para el dev, mensaje seguro para el cliente.
    console.error("[GET /api/_smoke] fallo de conexión a la base:", error);

    return NextResponse.json(
      { ok: false, error: "No se pudo conectar a la base de datos." },
      { status: 500 }
    );
  }
}
