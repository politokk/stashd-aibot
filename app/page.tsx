import { Button } from '@/components/ui/button';
import Link from 'next/link';

export default function Page() {
  return (
    <Button>
      <Link href="/chat">Chat</Link>
    </Button>
  );
} 