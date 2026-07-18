// POST /api/consults  → proxy to private backend (generate draft)
// GET  /api/consults   → list recent consults
import { NextRequest, NextResponse } from 'next/server';
import { backendFetch } from '@/app/lib/backend';

export async function POST(req: NextRequest) {
  const payload = await req.json();
  // TODO(auth): attach the authenticated clinician id from the session here.
  const { ok, status, body } = await backendFetch('/api/consults', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return NextResponse.json(body, { status: ok ? 200 : status });
}

export async function GET() {
  const { ok, status, body } = await backendFetch('/api/consults');
  return NextResponse.json(body, { status: ok ? 200 : status });
}
