import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Audio Ripples',
  description: 'Interactive audio web experience',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang='en'>
      <body className='m-0 p-0 overflow-hidden'>{children}</body>
    </html>
  );
}
