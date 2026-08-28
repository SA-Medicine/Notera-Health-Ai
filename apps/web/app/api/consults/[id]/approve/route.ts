// POST /api/consults/:id/approve → proxy sign-off (writes finals + feedback diff)
import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/app/lib/backend';

export const runtime = 'edge';   // required for Cloudflare Pages (@cloudflare/next-on-pages)

// Next 15: route-handler `params` is a Promise and must be awaited.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const payload = await req.json();
  const { id } = await params;
  const { ok, status, body } = await backendFetch(`/api/consults/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status: ok ? 200 : status });
}
