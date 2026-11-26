import '@/lib/normalize-env'
import { withAuth } from 'next-auth/middleware'

// withAuth redirects every request to /api/auth/error?error=Configuration when it
// cannot find a secret, so give it the same value src/lib/auth.ts signs cookies with.
const secret = (process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || '').trim().replace(/^["']+|["']+$/g, '').trim() || undefined

export const middleware = withAuth({
  secret,
  callbacks: {
    authorized: ({ token }) => !!token,
  },
  pages: {
    // Must match authOptions.pages.signIn in src/lib/auth.ts, otherwise an
    // unauthenticated /dashboard visit redirects to NextAuth's unstyled
    // default sign-in page instead of the app's home page.
    signIn: '/',
  },
})

export const config = {
  matcher: ['/dashboard/:path*'],
}
