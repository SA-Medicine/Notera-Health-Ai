import type { Metadata } from 'next';
import './globals.css';
import { AuthProvider } from './components/AuthProvider';
import TopBar from './components/TopBar';

export const metadata: Metadata = {
  title: 'Notera-Health-Ai — clinical documentation engine',
  description: 'Record, draft, review, and sign schema-structured SOAP notes. Gemini-powered, human-in-the-loop.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <TopBar />
          <main>{children}</main>
        </AuthProvider>
      </body>
    </html>
  );
}
