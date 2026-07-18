// GET /api/consults/:id → proxy to backend (fetch consult + draft)
import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/app/lib/backend';

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { ok, status, body } = await backendFetch(`/api/consults/${params.id}`);
  return NextResponse.json(body, { status: ok ? 200 : status });
}
