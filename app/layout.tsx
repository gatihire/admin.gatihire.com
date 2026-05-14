import type { Metadata } from 'next'
import './globals.css'
import { CandidateProvider } from '@/contexts/candidate-context'
import { CookieConsentWrapper } from '@/components/cookie-consent-wrapper'

export const metadata: Metadata = {
  title: 'GatiHire | Admin',
  description: 'Made with ❤️ by Bipul ',
  generator: 'GatiHire',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <body className="bg-gray-50" suppressHydrationWarning={true}>
        <CandidateProvider>
          {children}
          <CookieConsentWrapper />
        </CandidateProvider>
      </body>
    </html>
  )
}
