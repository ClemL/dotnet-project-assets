import Link from 'next/link';
import { linkBtn } from '@/components/ui/styles';

// Replaces Next's built-in 404 screen, which fills the viewport and would push the footer below the fold.
export default function NotFound() {
  return (
    <main className="mx-auto w-full max-w-[1400px] space-y-2 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-ink-2">
        This address is not part of Assets Graph.{' '}
        <Link href="/" className={linkBtn}>
          Open the analyzer
        </Link>
      </p>
    </main>
  );
}
