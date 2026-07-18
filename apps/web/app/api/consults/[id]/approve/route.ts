// POST /api/consults/:id/approve → proxy sign-off (writes finals + feedback diff)
import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/app/lib/backend';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const payload = await req.json();
  const { ok, status, body } = await backendFetch(`/api/consults/${params.id}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status: ok ? 200 : status });
}
