import { CampaignForm } from '@/components/campaigns/CampaignForm';

export default function NewCampaignPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-5 text-xl font-semibold">Nova campanha</h1>
      <CampaignForm />
    </div>
  );
}
