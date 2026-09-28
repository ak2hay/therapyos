'use client';
import { useParams } from 'next/navigation';
import { PublicFeedback } from '@/components/public-feedback';

export default function BranchFeedbackPage() {
  const { slug, code } = useParams<{ slug: string; code: string }>();
  return <PublicFeedback path={`branch/${encodeURIComponent(slug)}/${encodeURIComponent(code)}`} askContact />;
}
