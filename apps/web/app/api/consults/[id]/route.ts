// GET /api/consults/:id → proxy to backend (fetch consult + draft)
import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/app/lib/backend';

// Next 15: route-handler `params` is a Promise and must be awaited.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { ok, status, body } = await backendFetch(`/api/consults/${id}`);
  return NextResponse.json(body, { status: ok ? 200 : status });
}
