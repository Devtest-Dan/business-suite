import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-16 text-center">
      <h1 className="h1">This page does not exist</h1>
      <p className="muted mt-2">The link may be old, or the item was removed.</p>
      <Link href="/" className="btn btn-primary mt-6">
        Go home
      </Link>
    </main>
  );
}
