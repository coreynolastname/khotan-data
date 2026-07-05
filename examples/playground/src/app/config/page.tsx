import { KhotanHub } from "@/components/khotan/hub";

function getWebhookUrl(): string {
  return (
    process.env.KHOTAN_WEBHOOK_URL ||
    process.env.NGROK_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    "http://localhost:3000"
  );
}

export default function KhotanConfigPage() {
  const webhookUrl = getWebhookUrl();

  return (
    <main className="container mx-auto max-w-5xl px-4 py-10">
      <KhotanHub webhookUrl={webhookUrl} />
    </main>
  );
}
