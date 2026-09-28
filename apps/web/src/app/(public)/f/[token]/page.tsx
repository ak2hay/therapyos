'use client';
import { useParams } from 'next/navigation';
import { PublicFeedback } from '@/components/public-feedback';

export default function VisitFeedbackPage() {
  const { token } = useParams<{ token: string }>();
  return <PublicFeedback path={encodeURIComponent(token)} />;
}
