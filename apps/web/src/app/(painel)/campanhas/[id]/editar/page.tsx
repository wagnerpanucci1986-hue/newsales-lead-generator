'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CampaignForm } from '@/components/campaigns/CampaignForm';
import { api } from '@/lib/api';
import type { Campaign } from '@/lib/crm';

export default function EditCampaignPage() {
  const { id } = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ campaign: Campaign }>(`/campaigns/${id}`).then((r) => setCampaign(r.campaign)).catch((err) => setError(err.message));
  }, [id]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-5 text-xl font-semibold">Editar campanha</h1>
      {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      {campaign && campaign.status !== 'DRAFT' && <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900">Esta campanha já foi iniciada e não pode mais ser editada.</p>}
      {campaign?.status === 'DRAFT' && <CampaignForm campaign={campaign} />}
      {!campaign && !error && <p className="text-sm text-slate-500">Carregando…</p>}
    </div>
  );
}
